#!/usr/bin/env node
/**
 * laya-ultra-browser: an MCP server for browser control that does not lie about
 * whether an action worked.
 *
 * The reason this exists: on shadow-DOM-heavy single-page apps, a write can resolve
 * the element, report success, and change nothing. The in-page action layer here
 * descends to the real focusable control, writes through the native prototype setter,
 * fires composed events, and then reads the value back. A write that did not take
 * comes back as verified:false with the reason, never as a cheerful success.
 *
 * Local Laya ranking is an optional accelerator for choosing which element to act
 * on. It never performs the action and never decides that one succeeded.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPage, installSignalHandlers, isRunning, navigate, shutdown, withTimeout } from "./browser.js";
import { config } from "./config.js";
import { probeInjection } from "./inject.js";
import { cachedInfo, layaStatus, shutdown as shutdownLaya, warmup } from "./laya/client.js";
import { ActionableError, describeError, log } from "./log.js";
import {
  clickDeep,
  inspect as inspectTarget,
  isFresh,
  probeRef,
  readValue,
  selectOption,
  snapshot,
  writeText,
  type SnapshotElement,
  type Target,
} from "./page.js";
import { resolveTarget } from "./select.js";
import { record } from "./visualizer/events.js";
import {
  isRunning as visualizerRunning,
  start as startVisualizer,
  stop as stopVisualizer,
  url as visualizerUrl,
} from "./visualizer/server.js";

const server = new McpServer(
  { name: "laya-ultra-browser", version: "0.1.0" },
  {
    instructions: [
      "Browser control where every write is verified by reading the value back.",
      "",
      "Typical flow:",
      "1. browser_navigate to a URL.",
      "2. browser_snapshot to see what is on the page, with refs and occlusion state.",
      "3. browser_write_text / browser_click / browser_select_option, passing either a",
      "   ref from the snapshot or a natural-language goal. A goal is resolved by",
      "   local Laya ranking when available, otherwise by deterministic matching.",
      "4. Check `verified` on every write. If it is false the write did not land and",
      "   `reason` says why. Do not report success on an unverified write.",
      "",
      "browser_find returns ranked candidates with alternatives, which is the cheapest",
      "way to see what is on the page and what the model thinks about each option.",
    ].join("\n"),
  },
);

/** Wraps a handler so every failure comes back as readable tool output, never a crash. */
async function guard<T>(
  what: string,
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const value = await fn();
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const { message, hint } = describeError(err);
    log.warn(`${what} failed`, err);
    const body = hint ? `${message}\n\nHint: ${hint}` : message;
    return { content: [{ type: "text" as const, text: `Error: ${body}` }], isError: true };
  }
}

/**
 * Records a mutating action for the visualizer.
 *
 * The interesting column is `verified`, so it is recorded separately from `ok`. An
 * action can return ok while the read-back says the value never landed, and that gap
 * is precisely what the dashboard exists to make visible.
 */
function recordAction(args: {
  tool: string;
  target: string;
  ref: number | null;
  result: Record<string, unknown>;
  startedAt: number;
}): void {
  const verified = args.result.verified;
  record({
    kind: "action",
    tool: args.tool,
    target: args.target,
    ref: args.ref,
    ok: args.result.ok === true,
    verified: typeof verified === "boolean" ? verified : null,
    ...(typeof args.result.reason === "string" && args.result.reason
      ? { reason: args.result.reason }
      : {}),
    elapsedMs: Date.now() - args.startedAt,
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

server.registerTool(
  "browser_navigate",
  {
    title: "Navigate to a URL",
    description:
      "Open a URL in the managed browser and wait for the document to load. Returns the final URL, " +
      "title and HTTP status. A bare host like 'example.com' is treated as https.",
    inputSchema: {
      url: z.string().min(1).describe("URL to open. A scheme is optional."),
    },
  },
  async ({ url }) =>
    guard("browser_navigate", async () => {
      const result = await navigate(url);
      return {
        ok: true,
        requested: url,
        url: result.url,
        title: result.title,
        status: result.status,
      };
    }),
);

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const snapshotShape = {
  interactive: z
    .boolean()
    .default(true)
    .describe("Only list controls a user could operate. Turn off to include static text."),
  // No zod default on the two flags below: their default comes from
  // LAYA_INCLUDE_HIDDEN, so a server-wide setting actually takes effect. A zod default
  // would always win and the variable would do nothing.
  includeOffscreen: z
    .boolean()
    .optional()
    .describe("Include controls scrolled out of view. The accessibility tree lists them as if visible."),
  includeCovered: z
    .boolean()
    .optional()
    .describe("Include controls hidden behind an overlay or another element."),
  selector: z
    .string()
    .optional()
    .describe("CSS selector to scope the snapshot. Cannot cross shadow boundaries."),
  maxElements: z.number().int().min(1).max(2000).optional().describe("Cap on elements returned."),
  withPaths: z.boolean().default(false).describe("Include a readable DOM path per element."),
};

function renderSnapshot(
  elements: SnapshotElement[],
  stats: { emitted: number; fromShadow: number; openShadowRootsEntered: number; maxShadowDepth: number; truncated: boolean; suspectedClosedShadowRoots: number; crossOriginFramesBlocked: number; skippedOffscreen: number; skippedCovered: number },
  meta: { url: string; title: string },
): string {
  if (elements.length === 0) {
    return [
      `No matching controls on ${meta.url}`,
      "",
      "If you expected some, the usual causes are: the page has not finished rendering,",
      "the controls are inside a closed shadow root, or a selector scoped the search too narrowly.",
      "Try browser_snapshot with no selector and includeOffscreen=true.",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`${meta.title || "(no title)"}  ${meta.url}`);
  lines.push(
    `${elements.length} control(s); ${stats.fromShadow} behind a shadow boundary ` +
      `(open roots entered: ${stats.openShadowRootsEntered}, max depth ${stats.maxShadowDepth})`,
  );
  if (stats.truncated) lines.push("NOTE: truncated at the element cap, so this list is partial.");
  if (stats.suspectedClosedShadowRoots > 0) {
    lines.push(
      `NOTE: ${stats.suspectedClosedShadowRoots} element(s) look like they hold a closed shadow root. ` +
        "Those cannot be reached from page script by design.",
    );
  }
  if (stats.crossOriginFramesBlocked > 0) {
    lines.push(`NOTE: ${stats.crossOriginFramesBlocked} cross-origin frame(s) were not entered.`);
  }
  lines.push("");
  for (const el of elements) {
    const flags: string[] = [];
    if (el.disabled) flags.push("disabled");
    if (el.visibility !== "clear") flags.push(el.visibility);
    if (el.shadowDepth > 0) flags.push(`shadow:${el.shadowDepth}`);
    if (el.frameDepth > 0) flags.push(`frame:${el.frameDepth}`);
    const value = el.value ? ` value=${JSON.stringify(truncate(el.value, 60))}` : "";
    const href = el.href ? ` href=${truncate(el.href, 80)}` : "";
    lines.push(
      `ref=${el.ref}  ${el.role}  ${JSON.stringify(truncate(el.name || `(${el.tag})`, 90))}${value}${href}` +
        (flags.length ? `  [${flags.join(" ")}]` : "") +
        (el.path ? `\n      path: ${el.path}` : ""),
    );
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

server.registerTool(
  "browser_snapshot",
  {
    title: "Snapshot the page",
    description:
      "List interactive controls with stable refs, piercing open shadow roots and same-origin frames. " +
      "Also reports whether each control is offscreen or covered, which an accessibility tree does not " +
      "model. Refs stay valid until the page navigates or the DOM is replaced; pass one to the action " +
      "tools to target an element exactly.",
    inputSchema: snapshotShape,
  },
  async (args) =>
    guard("browser_snapshot", async () => {
      const page = await getPage();
      const snap = await snapshot(page, {
        interactive: args.interactive,
        includeUrls: true,
        includeOffscreen: args.includeOffscreen ?? config.includeHidden,
        includeCovered: args.includeCovered ?? config.includeHidden,
        withPaths: args.withPaths,
        maxElements: args.maxElements ?? config.maxSnapshotElements,
        ...(args.selector ? { selector: args.selector } : {}),
      });
      return renderSnapshot(snap.elements, snap.stats, snap.meta);
    }),
);

// ---------------------------------------------------------------------------
// Find: the Laya-accelerated ranking tool
// ---------------------------------------------------------------------------

server.registerTool(
  "browser_find",
  {
    title: "Rank page elements against a goal",
    description:
      "Return page elements ranked against a natural-language goal, using local Laya when available. " +
      "Cheaper than snapshotting repeatedly: no screenshot is taken and no remote model is called, one " +
      "forward pass scores every candidate. Read the alternatives before acting when `ambiguous` is true. " +
      "Laya's confidence is uncalibrated, so treat the ranking as a shortlist.",
    inputSchema: {
      goal: z.string().min(1).describe('What you are looking for, e.g. "the email address field".'),
      limit: z.number().int().min(1).max(25).default(8).describe("How many candidates to return."),
      selector: z.string().optional().describe("CSS selector to scope the search."),
      deterministic: z
        .boolean()
        .default(false)
        .describe("Skip Laya and match by name and role. Use when you need a reproducible answer."),
    },
  },
  async ({ goal, limit, selector, deterministic }) =>
    guard("browser_find", async () => {
      const page = await getPage();
      const proposal = await resolveTarget({ page, goal, selector, deterministic });
      const snap = await snapshot(page, { interactive: true, maxElements: config.maxSnapshotElements });
      const byRef = new Map(snap.elements.map((el) => [el.ref, el]));

      const rows: string[] = [];
      rows.push(`goal: ${goal}`);
      rows.push(
        `selected by: ${proposal.via}${proposal.score !== undefined ? ` (score ${proposal.score.toFixed(4)})` : ""}`,
      );
      if (proposal.ambiguous) {
        rows.push("AMBIGUOUS: the top candidates scored too closely to separate. Pass an explicit ref.");
      }
      // A disagreement between the model and name matching is the single most useful
      // signal here, so it leads rather than being buried in the notes.
      const disagreement = proposal.notes.find((n) => n.includes("disagree"));
      if (disagreement) rows.push(`WARNING: ${disagreement}`);

      rows.push("");
      rows.push(`ref=${proposal.ref}  <-- selected`);
      for (const alt of proposal.alternatives.slice(0, limit - 1)) {
        const el = byRef.get(alt.ref);
        const flags = el?.disabled ? " [disabled]" : el && el.visibility !== "clear" ? ` [${el.visibility}]` : "";
        rows.push(`ref=${alt.ref}    ${alt.role}  ${JSON.stringify(truncate(alt.name, 90))}${flags}`);
      }
      for (const note of proposal.notes) rows.push(`\nnote: ${note}`);
      return rows.join("\n");
    }),
);

// ---------------------------------------------------------------------------
// Verified actions
// ---------------------------------------------------------------------------

const targetShape = {
  ref: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Ref from browser_snapshot. Exact targeting, bypasses selection."),
  goal: z
    .string()
    .optional()
    .describe('Natural-language target, e.g. "the email address field". Ranked by Laya when available.'),
  selector: z.string().optional().describe("CSS selector, resolved through open shadow roots."),
  name: z.string().optional().describe("Exact accessible name to match."),
  role: z.string().optional().describe("Role to require, e.g. textbox, searchbox, button."),
  noDescend: z
    .boolean()
    .default(false)
    .describe("Write to the matched element instead of the control inside it. Almost always wrong."),
  deterministic: z.boolean().default(false).describe("Resolve the goal without Laya."),
};

/** Builds an in-page target from explicit arguments, or resolves a goal to a ref. */
async function buildTarget(
  goal: string | undefined,
  explicit: {
    ref?: number | undefined;
    selector?: string | undefined;
    name?: string | undefined;
    role?: string | undefined;
  },
  opts: { page: Awaited<ReturnType<typeof getPage>>; deterministic: boolean },
): Promise<{ target: Target; describe: string; notes: string[] }> {
  if (explicit.ref !== undefined) {
    // Check the ref before acting on it. walker.js already fails closed on an
    // unresolvable ref, but its message is generic; asking whether the node is still
    // rendered and unoccluded turns "did not resolve" into the things that actually
    // went wrong, which is the difference between a retryable error and a dead end.
    if (!(await isFresh(opts.page, explicit.ref))) {
      const why = await probeRef(opts.page, explicit.ref);
      throw new ActionableError(
        `ref ${explicit.ref} is stale: ${why}.`,
        "Refs stay valid until the page navigates or the DOM is replaced. Call browser_snapshot again and use a ref from the new list, or pass a goal instead.",
      );
    }
    return { target: { ref: explicit.ref }, describe: `ref ${explicit.ref}`, notes: [] };
  }
  if (explicit.selector) {
    return { target: { css: explicit.selector }, describe: `css ${explicit.selector}`, notes: [] };
  }
  if (explicit.name) {
    return {
      target: { name: explicit.name, ...(explicit.role ? { role: explicit.role } : {}) },
      describe: `name ${JSON.stringify(explicit.name)}`,
      notes: [],
    };
  }
  if (goal) {
    const proposal = await resolveTarget({ page: opts.page, goal, deterministic: opts.deterministic });
    return {
      target: proposal.target,
      describe:
        `goal ${JSON.stringify(goal)} -> ref ${proposal.ref}` +
        (proposal.score !== undefined ? ` (${proposal.via}, score ${proposal.score.toFixed(4)})` : ` (${proposal.via})`),
      notes: proposal.ambiguous
        ? [...proposal.notes, "AMBIGUOUS: top candidates were too close. Verify the target before relying on this write."]
        : proposal.notes,
    };
  }
  throw new ActionableError(
    "No target given.",
    "Pass a ref from browser_snapshot, or a goal describing the element, or a selector or name.",
  );
}

function actionReport(
  what: string,
  resolved: { describe: string; notes: string[] },
  result: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const ok = result.ok === true;
  const verified = result.verified;

  if (ok && verified !== false) {
    lines.push(`${what}: ok`);
  } else {
    lines.push(`${what}: FAILED`);
  }
  lines.push(`target: ${resolved.describe}`);

  if (result.reason) lines.push(`reason: ${String(result.reason)}`);
  if (result.stage) lines.push(`stage: ${String(result.stage)}`);

  if (what.startsWith("write")) {
    lines.push(`verified: ${verified === true ? "yes" : "NO"}`);
    if (result.valueBefore !== undefined) {
      lines.push(`value: ${JSON.stringify(result.valueBefore ?? null)} -> ${JSON.stringify(result.valueAfter ?? null)}`);
    }
    if (result.hostEchoedValue === true) {
      lines.push(
        "hostEchoedValue: the wrapper accepted the value but the real control inside it did not. " +
          "Do not pass noDescend for component-library fields.",
      );
    }
    if (result.setterUsed) lines.push(`setter: ${String(result.setterUsed)}`);
    if (result.descendedToInnerNode) {
      lines.push(`descended into <${String(result.hostTag ?? "host")}> to reach the real control`);
    }
  }
  if (result.element) lines.push(`element: ${JSON.stringify(result.element)}`);
  if (Array.isArray(result.textEntryCandidates) && result.textEntryCandidates.length > 0) {
    lines.push("text fields on this page:");
    for (const c of result.textEntryCandidates as Array<{ tag: string; id: string; name: string }>) {
      lines.push(`  <${c.tag}${c.id ? ` id=${c.id}` : ""}> ${JSON.stringify(truncate(c.name, 70))}`);
    }
  }
  if (result.ambiguous === true) lines.push("AMBIGUOUS: more than one element matched.");
  if (result.candidates !== undefined && Number(result.candidates) > 1) {
    lines.push(`candidates: ${String(result.candidates)}`);
  }
  for (const note of resolved.notes) lines.push(`note: ${note}`);

  if (!ok) {
    lines.push("");
    lines.push("This did not happen. Do not report it as done.");
  }
  return lines.join("\n");
}

server.registerTool(
  "browser_write_text",
  {
    title: "Write text into a field, verified",
    description:
      "Set the value of a text field, then read it back to confirm it persisted. Resolves through open " +
      "shadow roots, descends from a component host to the real inner control, writes through the native " +
      "value setter and fires composed input/change events. Returns verified:true only when the value was " +
      "read back off the real control. A silent no-op comes back as verified:false with a reason.",
    inputSchema: {
      ...targetShape,
      value: z.string().describe("Text to write. An empty string clears the field."),
    },
  },
  async (args) =>
    guard("browser_write_text", async () => {
      const page = await getPage();
      const startedAt = Date.now();
      const resolved = await buildTarget(args.goal, args, { page, deterministic: args.deterministic });
      const result = await withTimeout(
        writeText(page, resolved.target, args.value, { noDescend: args.noDescend }),
        config.callTimeoutMs,
        "The write did not complete",
      );
      const plain = result as unknown as Record<string, unknown>;
      recordAction({
        tool: "browser_write_text",
        target: resolved.describe,
        ref: resolved.target.ref ?? null,
        result: plain,
        startedAt,
      });
      return actionReport("write_text", resolved, plain);
    }),
);

server.registerTool(
  "browser_click",
  {
    title: "Click an element",
    description:
      "Click a control, resolving through open shadow roots and descending from a component host to the " +
      "real inner button or link. Reports whether the URL changed and whether the page's child count " +
      "moved, as weak signals that something happened. A click is not proof of outcome: verify the effect " +
      "you expected with a follow-up snapshot or read.",
    inputSchema: {
      ...targetShape,
    },
  },
  async (args) =>
    guard("browser_click", async () => {
      const page = await getPage();
      const resolved = await buildTarget(args.goal, args, { page, deterministic: args.deterministic });
      const result = await withTimeout(
        clickDeep(page, resolved.target, { noDescend: args.noDescend }),
        config.callTimeoutMs,
        "The click did not complete",
      );
      const report = actionReport("click", resolved, result as unknown as Record<string, unknown>);
      return `${report}\nnote: ${String(result.note ?? "")}\nurlChanged: ${String(result.urlChanged)}`;
    }),
);

server.registerTool(
  "browser_select_option",
  {
    title: "Select a dropdown option, verified",
    description:
      "Choose an option in a native <select> and confirm the selection stuck. Component-library " +
      "dropdowns (a button plus a listbox) are not native selects: click the button, then click the option.",
    inputSchema: {
      ...targetShape,
      value: z.string().describe("Option value, label or text to match."),
    },
  },
  async (args) =>
    guard("browser_select_option", async () => {
      const page = await getPage();
      const startedAt = Date.now();
      const resolved = await buildTarget(args.goal, args, { page, deterministic: args.deterministic });
      const result = await withTimeout(
        selectOption(page, resolved.target, args.value, { noDescend: args.noDescend }),
        config.callTimeoutMs,
        "The selection did not complete",
      );
      const plain = result as unknown as Record<string, unknown>;
      recordAction({
        tool: "browser_select_option",
        target: resolved.describe,
        ref: resolved.target.ref ?? null,
        result: plain,
        startedAt,
      });
      if (Array.isArray(result.options) && result.options.length > 0) {
        const report = actionReport("select_option", resolved, plain);
        return `${report}\navailable: ${result.options.map((o) => JSON.stringify(o)).join(", ")}`;
      }
      return actionReport("select_option", resolved, plain);
    }),
);

server.registerTool(
  "browser_inspect",
  {
    title: "Inspect an element without changing anything",
    description:
      "Report what an element is, whether it is reachable, what it currently holds, and whether the " +
      "action layer would descend past a component host to reach the real control. Use this to work out " +
      "why a write failed before retrying.",
    inputSchema: {
      ref: z.number().int().positive().optional(),
      goal: z.string().optional(),
      selector: z.string().optional(),
      name: z.string().optional(),
      role: z.string().optional(),
      deterministic: z.boolean().default(false),
    },
  },
  async (args) =>
    guard("browser_inspect", async () => {
      const page = await getPage();
      const resolved = await buildTarget(args.goal, args, { page, deterministic: args.deterministic });
      const result = await inspectTarget(page, resolved.target);
      return {
        target: resolved.describe,
        ...result,
        notes: resolved.notes,
      };
    }),
);

server.registerTool(
  "browser_read_value",
  {
    title: "Read a field's current value",
    description:
      "Read what a field currently holds, resolving through open shadow roots and descending to the real " +
      "inner control. Use this to confirm state independently of a write's own verification.",
    inputSchema: {
      ref: z.number().int().positive().optional(),
      goal: z.string().optional(),
      selector: z.string().optional(),
      name: z.string().optional(),
      role: z.string().optional(),
      deterministic: z.boolean().default(false),
    },
  },
  async (args) =>
    guard("browser_read_value", async () => {
      const page = await getPage();
      const resolved = await buildTarget(args.goal, args, { page, deterministic: args.deterministic });
      const value = await readValue(page, resolved.target);
      return { target: resolved.describe, value, notes: resolved.notes };
    }),
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

server.registerTool(
  "browser_status",
  {
    title: "Check what is available",
    description:
      "Report browser state, whether the in-page layer is installed, and whether local Laya ranking is " +
      "usable. Run this first when a tool fails, and after setup. With warm=true it also loads the Laya " +
      "model so the first real ranking call is fast.",
    inputSchema: {
      warm: z.boolean().default(false).describe("Load the Laya model now, which can take a while on first run."),
    },
  },
  async ({ warm }) =>
    guard("browser_status", async () => {
      const status = await layaStatus();
      const out: Record<string, unknown> = {
        browser: {
          running: isRunning(),
          headed: config.headed,
          profileDir: config.profileDir,
        },
        laya: status.available
          ? { available: true, python: status.python, model: status.model, checkpoint: status.checkpoint }
          : { available: false, reason: status.reason, hint: status.hint, tried: status.tried },
        injected: null,
        limits: {
          callTimeoutMs: config.callTimeoutMs,
          navigationTimeoutMs: config.navigationTimeoutMs,
          maxSnapshotElements: config.maxSnapshotElements,
          layaMaxOptions: config.laya.maxOptions,
          layaMode: config.laya.mode,
        },
        visualizer: {
          enabled: config.visualizer.enabled,
          running: visualizerRunning(),
          url: visualizerRunning() ? visualizerUrl() : null,
        },
      };

      if (isRunning()) {
        const page = await getPage();
        out.injected = await probeInjection(page);
        out.page = { url: page.url() };
      } else {
        out.injected = "browser not started yet, call browser_navigate";
      }

      if (warm && status.available) {
        out.layaInfo = await withTimeout(
          warmup(),
          config.laya.startupTimeoutMs,
          "Loading the Laya model timed out",
          "First run downloads roughly 2GB of weights. Raise LAYA_STARTUP_TIMEOUT_MS if it is still downloading.",
        );
      } else {
        // Report whatever the last warmup learned, so a status call after a ranking
        // still shows the checkpoint's real context and option-head budget without
        // paying to load it again.
        const info = cachedInfo();
        if (info) out.layaInfo = info;
      }
      return out;
    }),
);
// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installSignalHandlers();

  // Started before the transport so the URL is available to the first status call.
  // A failure here is already swallowed inside start(); the tools do not depend on it.
  await startVisualizer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("laya-ultra-browser MCP server ready on stdio");

  const status = await layaStatus();
  if (!status.available) {
    log.warn(`local Laya ranking is unavailable: ${status.reason}`);
    log.warn(`hint: ${status.hint}`);
  }
}

async function cleanup(): Promise<void> {
  await Promise.allSettled([shutdownLaya(), shutdown(), stopVisualizer()]);
}

for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
  if (signal === "exit") {
    process.on("exit", () => {
      void cleanup();
    });
  } else {
    process.on(signal, () => {
      void cleanup();
    });
  }
}

main().catch((err) => {
  log.error("fatal: server failed to start", err);
  process.exit(1);
});
