/**
 * Visualizer event stream.
 *
 * A bounded, in-memory log of what the ranker did, plus a subscriber list so the
 * dashboard receives updates as they happen rather than only on request.
 *
 * Two properties matter more than features here:
 *
 *   - Bounded. A long agent session makes thousands of ranking calls. An unbounded
 *     array would grow until the process died, so this is a ring and every subscriber
 *     receives a copy rather than a live reference.
 *   - Never throws into the caller. Recording an event is observability, so a failure
 *     here must not be able to fail a tool call.
 */
import { log } from "../log.js";

export type CandidateScore = {
  ref: number;
  /** Raw model score. Not a calibrated probability; see the calibration note. */
  score: number;
  role: string | null;
  name: string | null;
};

export type RankEvent = {
  kind: "rank";
  id: number;
  at: number;
  goal: string;
  mode: "choice" | "noul";
  /** Candidates the deterministic pre-filter passed to the model, with their scores. */
  considered: CandidateScore[];
  /** How many candidates were dropped before the model saw them. */
  pruned: number;
  /** How many interactive controls the snapshot produced in total. */
  total: number;
  /** Which ref was ultimately acted on, when known. */
  selectedRef: number | null;
  /** True when the model and the deterministic fallback chose different winners. */
  disagreedWithDeterministic: boolean | null;
  elapsedMs: number;
  /** Always false today, and surfaced in the UI so nobody reads these as probabilities. */
  calibrated: false;
  error?: string;
};

export type ActionEvent = {
  kind: "action";
  id: number;
  at: number;
  tool: string;
  target: string;
  ok: boolean;
  /** True only when the value was read back off the real control. Null when not applicable. */
  verified: boolean | null;
  ref: number | null;
  reason?: string;
  elapsedMs: number;
};

export type NoteEvent = {
  kind: "note";
  id: number;
  at: number;
  level: "info" | "warn";
  message: string;
};

export type VisualizerEvent = RankEvent | ActionEvent | NoteEvent;

/**
 * What callers pass to record(): a VisualizerEvent minus the fields the buffer owns.
 *
 * A distributive conditional rather than a plain Omit, so it distributes across the
 * union. A bare Omit<VisualizerEvent, "id" | "at"> collapses the union into one shape
 * with every field present-but-optional, which accepts nonsense and defeats the point
 * of the discriminated `kind`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type VisualizerEventInput = DistributiveOmit<VisualizerEvent, "id" | "at">;

type Subscriber = (event: VisualizerEvent) => void;

let nextId = 1;
let history: VisualizerEvent[] = [];
let limit = 200;
const subscribers = new Set<Subscriber>();

/** Sets how many events to retain. Older events are dropped from the front. */
export function configure(maxEvents: number): void {
  limit = Math.max(1, Math.floor(maxEvents));
  trim();
}

function trim(): void {
  if (history.length > limit) {
    history = history.slice(history.length - limit);
  }
}

/**
 * Records an event and fans it out to subscribers.
 *
 * Returns the stored event with its assigned id, so a caller can correlate an
 * in-flight ranking with the action that followed it.
 */
export function record(event: VisualizerEventInput): VisualizerEvent {
  const full: VisualizerEvent = { ...event, id: nextId++, at: Date.now() } as VisualizerEvent;
  history.push(full);
  trim();
  for (const sub of subscribers) {
    // A broken subscriber must not take down the tool call that produced the event.
    try {
      sub(full);
    } catch (err) {
      log.debug("visualizer subscriber threw", err);
    }
  }
  return full;
}

/** A copy of the retained history, oldest first. */
export function snapshot(): VisualizerEvent[] {
  return history.slice();
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function clear(): void {
  history = [];
}
