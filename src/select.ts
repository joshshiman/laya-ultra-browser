/**
 * Turning "the email field" into something the verified action layer can act on.
 *
 * Two paths, in priority order:
 *
 *   1. Laya ranking. The goal plus the candidate table go to the local model, which
 *      returns a shortlist with probabilities. This is what removes the per-step
 *      screenshot-and-LLM round trip: no image is ever sent, and one forward pass
 *      ranks every candidate.
 *
 *   2. Deterministic fallback. If Laya is unavailable, the goal is matched against
 *      accessible names and roles directly. Slower to be clever, but it always works
 *      and it has no moving parts.
 *
 * Either way the result is only ever a *proposal*. The action layer re-resolves the
 * ref, writes, and reads the value back, so a wrong pick shows up as a failure or as
 * an unexpected target rather than as a silent success.
 */
import type { Page } from "playwright";
import { config } from "./config.js";
import type { RankedCandidate } from "./laya/client.js";
import { rank } from "./laya/client.js";
import { log } from "./log.js";
import { snapshot, type SnapshotElement, type Target } from "./page.js";
import { record } from "./visualizer/events.js";

export type Proposal = {
  /** The target to hand to the action layer. */
  target: Target;
  ref: number;
  /** How the target was chosen. */
  via: "laya" | "deterministic" | "explicit-ref";
  /** Model confidence in [0,1] when via==="laya". Not a calibrated probability. */
  score?: number;
  /** Runners-up, so the agent can retry with a different element. */
  alternatives: Array<{ ref: number; score?: number; name: string; role: string }>;
  /** True when the top two were close enough that the pick is a coin flip. */
  ambiguous: boolean;
  /** Notes the agent should see: pruning, fallback reason, calibration caveat. */
  notes: string[];
};

/** Below this margin between first and second place, the pick is treated as a toss-up. */
const AMBIGUITY_MARGIN = 0.08;

function toTarget(ref: number): Target {
  return { ref };
}

function describeCandidate(el: SnapshotElement): { name: string; role: string } {
  return { name: el.name || `(${el.tag})`, role: el.role };
}

/**
 * Deterministic matching: score every visible element against the goal using token
 * overlap on the accessible name plus a role hint. Intentionally simple and
 * explainable, because when Laya is not available this is the only thing standing
 * between the agent and a wrong click.
 *
 * Exported for direct testing. It is pure, so it needs no browser and no model, which
 * is the only way to test it honestly.
 */
export function deterministicScore(goal: string, el: SnapshotElement): number {
  // Collapse every run of non-alphanumerics to a single space, then collapse the
  // whitespace that leaves behind. Doing only the first step is a subtle bug: "email,"
  // and "email address" would normalize to strings that differ by a double space, so
  // the substring bonus below would fire for one and miss for the other.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const STOP = new Set([
    "the", "a", "an", "of", "to", "in", "on", "at", "for", "with", "and", "or",
    "field", "input", "box", "button", "link", "text", "please", "click", "select",
    "choose", "pick", "find", "get", "set", "enter", "fill", "type", "value", "page",
  ]);
  const goalTokens = new Set(norm(goal).split(/\s+/).filter((t) => t && !STOP.has(t)));

  const nameTokens = new Set(norm(el.name).split(/\s+/).filter((t) => t && !STOP.has(t)));
  let score = 0;
  for (const t of goalTokens) if (nameTokens.has(t)) score += 1;

  // A substring hit is a strong signal that token overlap can miss on phrases.
  const nameNorm = norm(el.name);
  if (nameNorm && nameNorm.length > 2 && norm(goal).includes(nameNorm)) score += 2;

  // Reward a role that agrees with the action the goal implies.
  if (/\b(click|press|open|select|choose|tap)\b/.test(norm(goal)) && el.role === "button") score += 0.5;
  if (/\b(type|enter|fill|write|input|search)\b/.test(norm(goal)) && /textbox|searchbox|spinbutton/.test(el.role)) {
    score += 0.5;
  }

  if (el.disabled) score -= 1.5;
  if (el.visibility !== "clear") score -= 1;
  return score;
}

export type ResolveInput = {
  page: Page;
  /** Natural-language description of the element to act on. */
  goal?: string | undefined;
  /** Explicit ref from a prior snapshot, which bypasses selection entirely. */
  ref?: number | undefined;
  /** Narrow the candidate pool to a CSS selector before ranking. */
  selector?: string | undefined;
  /** Skip Laya and match deterministically even when it is available. */
  deterministic?: boolean | undefined;
};

export async function resolveTarget(input: ResolveInput): Promise<Proposal> {
  const { page, goal, ref, selector } = input;

  if (ref !== undefined) {
    return {
      target: toTarget(ref),
      ref,
      via: "explicit-ref",
      alternatives: [],
      ambiguous: false,
      notes: ["Targeted an explicit ref from a prior snapshot."],
    };
  }

  if (!goal || !goal.trim()) {
    throw new Error("Provide either a ref or a goal describing the element to act on.");
  }

  const snap = await snapshot(page, {
    interactive: true,
    includeUrls: true,
    includeOffscreen: false,
    includeCovered: false,
    ...(selector ? { selector } : {}),
  });

  if (snap.error) {
    throw new Error(`Snapshot failed: ${snap.error}`);
  }
  if (snap.elements.length === 0) {
    throw new Error(
      "No interactive elements matched. The page may still be loading, the elements may be hidden, or a selector may have scoped the search too narrowly.",
    );
  }

  const notes: string[] = [];

  if (!input.deterministic) {
    const started = Date.now();
    try {
      const candidates = snap.elements.map((el) => ({
        ref: el.ref,
        role: el.role,
        name: el.name,
        value: el.value,
        disabled: el.disabled,
        visibility: el.visibility,
      }));
      const result = await rank(goal, candidates);
      const top = result.ranked[0];
      if (top) {
        const byRef = new Map(snap.elements.map((el) => [el.ref, el]));
        const second = result.ranked[1];
        const ambiguous =
          second !== undefined && Math.abs(top.score - second.score) < AMBIGUITY_MARGIN;

        if (result.pruned > 0) {
          notes.push(
            `${result.pruned} candidate(s) were pruned before ranking: Laya's option head has a fixed token budget, so a lexical pre-filter shortlists the field first.`,
          );
        }
        notes.push(
          "Laya's confidence is not calibrated. Treat the ranking as a shortlist, not a probability, and check the returned element before relying on a write.",
        );

        record({
          kind: "rank",
          goal,
          mode: result.mode === "noul" ? "noul" : "choice",
          considered: result.ranked.map((r) => ({
            ref: r.ref,
            score: r.score,
            role: r.role,
            name: r.name,
          })),
          pruned: result.pruned,
          total: snap.elements.length,
          selectedRef: top.ref,
          disagreedWithDeterministic: null,
          elapsedMs: Math.round(Date.now() - started),
          calibrated: false,
        });

        return {
          target: toTarget(top.ref),
          ref: top.ref,
          via: "laya",
          score: top.score,
          ambiguous,
          alternatives: result.ranked.slice(1, 6).map((r: RankedCandidate) => {
            const el = byRef.get(r.ref);
            return {
              ref: r.ref,
              score: r.score,
              name: el ? el.name : `ref ${r.ref}`,
              role: el ? el.role : "unknown",
            };
          }),
          notes,
        };
      }
      notes.push("Laya returned no ranking; fell back to deterministic matching.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("laya ranking unavailable, using deterministic matching", message);
      notes.push(`Laya ranking unavailable (${message}). Used deterministic matching instead.`);
      record({
        kind: "rank",
        goal,
        mode: config.laya.mode,
        considered: [],
        pruned: 0,
        total: snap.elements.length,
        selectedRef: null,
        disagreedWithDeterministic: null,
        elapsedMs: Math.round(Date.now() - started),
        calibrated: false,
        error: message,
      });
    }
  }

  const scored = snap.elements
    .map((el) => ({ el, score: deterministicScore(goal, el) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) {
    throw new Error("No candidate elements were available to match against.");
  }
  const second = scored[1];
  const ambiguous = second !== undefined && Math.abs(top.score - second.score) < 0.5;

  return {
    target: toTarget(top.el.ref),
    ref: top.el.ref,
    via: "deterministic",
    score: top.score,
    ambiguous,
    alternatives: scored.slice(1, 6).map(({ el, score }) => ({
      ref: el.ref,
      score,
      name: el.name || `(${el.tag})`,
      role: el.role,
    })),
    notes,
  };
}
