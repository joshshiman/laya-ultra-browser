/**
 * Injection of the in-page layer (walker.js + actions.js).
 *
 * The two scripts are plain JS IIFEs that install window.__laya. They are read from
 * disk as source text and evaluated in the page, which is the whole reason they were
 * written without imports or a build step.
 *
 * Installation uses an init script so it survives navigation and re-runs in the top
 * frame of every document. Without that, any navigation silently loses the layer and
 * every subsequent tool fails with "window.__laya is undefined" -- a failure that
 * looks like a bug in the tool rather than a missing install.
 */
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { assetPath } from "./config.js";
import { ActionableError, log } from "./log.js";

let walkerSource: string | null = null;
let actionsSource: string | null = null;

function readSources(): { walker: string; actions: string } {
  if (walkerSource === null || actionsSource === null) {
    try {
      walkerSource = readFileSync(assetPath("snapshot", "walker.js"), "utf8");
      actionsSource = readFileSync(assetPath("snapshot", "actions.js"), "utf8");
    } catch (err) {
      throw new ActionableError(
        `Could not read the in-page scripts from ${assetPath("snapshot")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "The build did not copy src/snapshot into dist/. Run: npm run build",
      );
    }
  }
  return { walker: walkerSource, actions: actionsSource };
}

/** Freshness marker, so a re-injected build replaces an older one in place. */
const BUILD_ID = `laya-ultra-browser@${process.env.npm_package_version ?? "0.1.0"}`;

/**
 * Wrapper evaluated in the page. Guarded to the top frame: the walker pierces
 * same-origin frames from the top document itself, so installing into subframes too
 * would just create competing window.__laya objects inside each frame.
 *
 * The body is spliced in as a statement, not as a returned expression. Both in-page
 * files are IIFEs that end in a semicolon, so prefixing them with `return` would hand
 * back the IIFE's own completion value and skip every line after it.
 *
 * Success is confirmed by probing window.__laya rather than by the absence of a throw.
 * A script can evaluate cleanly and still fail to install anything.
 */
function wrapper(body: string, probe: string): string {
  return `(function () {
  try {
    if (window.top !== window) return "skipped: not the top frame";
  } catch (e) {
    return "skipped: cross-origin frame";
  }
  try {
    ${body}
  } catch (e) {
    return "threw: " + (e && e.message ? e.message : String(e));
  }
  if (${probe}) {
    window.__laya_build = ${JSON.stringify(BUILD_ID)};
    return "installed";
  }
  return "ran without error but ${probe} is missing";
})()`;
}

const HAS_WALKER = "typeof window.__laya?.snapshot === 'function'";
const HAS_ACTIONS = "typeof window.__laya?.writeText === 'function'";

const INSTALL_WALKER = wrapper(readSources().walker, HAS_WALKER);
const INSTALL_ACTIONS = wrapper(readSources().actions, HAS_ACTIONS);

let contextInstalled: BrowserContext | null = null;
let installing: Promise<void> | null = null;

/**
 * Installs the init scripts once per context.
 *
 * Guarded by a shared promise rather than a boolean alone. MCP clients are free to call
 * tools concurrently, and two overlapping ensureInjected calls both saw
 * contextInstalled !== ctx and both ran addInitScript, so every subsequent document
 * evaluated the layer twice. Harmless, because both files are idempotent, but it
 * doubled the injected bytes on every page for the rest of the session.
 */
async function installOnContext(ctx: BrowserContext): Promise<void> {
  if (contextInstalled === ctx) return;
  if (installing) {
    await installing;
    if (contextInstalled === ctx) return;
  }
  const pending = (async () => {
    await ctx.addInitScript({ content: INSTALL_WALKER });
    await ctx.addInitScript({ content: INSTALL_ACTIONS });
    contextInstalled = ctx;
    log.debug("init scripts installed on the browser context");
  })();
  installing = pending;
  try {
    await pending;
  } finally {
    if (installing === pending) installing = null;
  }
}

export type InjectStatus = {
  walker: string;
  actions: string;
  build: string | null;
  generation: number | null;
};

/**
 * Ensures window.__laya exists in the page's top frame, injecting it if the document
 * was loaded before this server attached or navigated without going through the
 * init script. Idempotent: walker.js bumps a generation counter, and actions.js
 * merges into the existing object, so re-injection is safe and never leaves the
 * caller with a half-installed layer.
 */
/**
 * Pages whose current document is known to have the layer.
 *
 * Probing on every call was pure overhead. A single action used to cost four round
 * trips to the renderer for one unit of work, because snapshot, the freshness check and
 * the action each re-probed window.__laya before doing anything. Every probe is a CDP
 * round trip and forces the renderer to run script, so this was the single largest
 * source of per-action latency in the server.
 *
 * The init script re-installs the layer on every new document, so the entry only has to
 * be dropped when the document changes, not on every call.
 */
const confirmed = new WeakMap<Page, InjectStatus>();
const watched = new WeakSet<Page>();

function watch(page: Page): void {
  if (watched.has(page)) return;
  watched.add(page);
  const forget = () => confirmed.delete(page);
  // Any navigation produces a new document, and a detached frame is gone. Both mean
  // the next call has to probe again.
  page.on("framenavigated", forget);
  page.on("framedetached", forget);
  page.on("close", forget);
}

/** Returned by a work evaluate that found no layer installed. */
export const NEEDS_INSTALL = "__laya_needs_install__";

/**
 * Runs page-side work that needs window.__laya, installing it first if necessary.
 *
 * The point is the round-trip count. Checking for the layer in its own evaluate and
 * then running the work in a second one doubles the cost of every call on the first
 * use after a navigation, and a navigation happens between most task steps. So the
 * check rides along inside the same evaluate as the work, and installation only costs
 * an extra round trip when the layer genuinely is missing.
 *
 * `body` is written at each call site rather than passed in, because Playwright
 * serialises arguments and a function cannot cross that boundary.
 */
export async function withLayer<T>(
  page: Page,
  work: (arg: never) => T | typeof NEEDS_INSTALL,
  arg: unknown,
): Promise<T> {
  watch(page);
  if (!confirmed.get(page)) await installOnContext(page.context());

  const out = (await page.evaluate(work as (a: unknown) => unknown, arg)) as
    | T
    | typeof NEEDS_INSTALL;

  if (out !== NEEDS_INSTALL) {
    confirmed.set(page, {
      walker: "present",
      actions: "present",
      build: BUILD_ID,
      generation: null,
    });
    return out as T;
  }

  // The layer really is absent: install it, then do the work. This costs two round
  // trips, but it is the rare path and the alternative is a second evaluate on every
  // single call.
  const status = await installNow(page);
  return (await page.evaluate(work as (a: unknown) => unknown, arg)) as T;
}

/** Installs the layer and reports what happened. */
async function installNow(page: Page): Promise<InjectStatus> {
  const walkerResult = (await page.evaluate(INSTALL_WALKER)) as string;
  if (walkerResult !== "installed" && walkerResult !== "skipped: not the top frame") {
    throw new ActionableError(
      `Failed to install the snapshot walker: ${walkerResult}`,
      "This usually means the page blocked script evaluation. Try a page that is not behind a strict CSP, or set LAYA_LOG_LEVEL=debug for the full error.",
    );
  }
  const actionsResult = (await page.evaluate(INSTALL_ACTIONS)) as string;
  if (actionsResult !== "installed" && actionsResult !== "skipped: not the top frame") {
    throw new ActionableError(`Failed to install the action layer: ${actionsResult}`);
  }
  confirmed.set(page, {
    walker: walkerResult,
    actions: actionsResult,
    build: BUILD_ID,
    generation: null,
  });
  return confirmed.get(page)!;
}

export async function ensureInjected(page: Page): Promise<InjectStatus> {
  watch(page);
  const known = confirmed.get(page);
  if (known) return known;

  const ctx = page.context();
  await installOnContext(ctx);

  const status = await page.evaluate(() => {
    const w = window as unknown as {
      __laya?: { snapshot?: unknown; writeText?: unknown; generation?: number };
      __laya_build?: string;
    };
    return {
      hasWalker: typeof w.__laya?.snapshot === "function",
      hasActions: typeof w.__laya?.writeText === "function",
      build: w.__laya_build ?? null,
      generation: typeof w.__laya?.generation === "number" ? w.__laya.generation : null,
    };
  });

  if (status.hasWalker && status.hasActions) {
    const resolved: InjectStatus = {
      walker: "present",
      actions: "present",
      build: status.build,
      generation: status.generation,
    };
    confirmed.set(page, resolved);
    return resolved;
  }

  log.debug("in-page layer missing, injecting now");
  const walkerResult = (await page.evaluate(INSTALL_WALKER)) as string;
  if (walkerResult !== "installed" && walkerResult !== "skipped: not the top frame") {
    throw new ActionableError(
      `Failed to install the snapshot walker: ${walkerResult}`,
      "This usually means the page blocked script evaluation. Try a page that is not behind a strict CSP, or set LAYA_LOG_LEVEL=debug for the full error.",
    );
  }
  const actionsResult = (await page.evaluate(INSTALL_ACTIONS)) as string;
  if (actionsResult !== "installed" && actionsResult !== "skipped: not the top frame") {
    throw new ActionableError(`Failed to install the action layer: ${actionsResult}`);
  }

  const resolved: InjectStatus = {
    walker: walkerResult,
    actions: actionsResult,
    build: BUILD_ID,
    generation: null,
  };
  if (walkerResult === "installed" && actionsResult === "installed") {
    confirmed.set(page, resolved);
  }
  return resolved;
}

/**
 * Drops the cached confirmation for a page, forcing the next call to probe.
 *
 * Used by tests, and by anything that loads a document in a way the navigation events
 * do not describe.
 */
export function forgetInjection(page: Page): void {
  confirmed.delete(page);
}

/** Reports whether the layer is present without attempting to install it. */
export async function probeInjection(page: Page): Promise<InjectStatus> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __laya?: { snapshot?: unknown; writeText?: unknown; generation?: number };
      __laya_build?: string;
    };
    return {
      walker: typeof w.__laya?.snapshot === "function" ? "present" : "absent",
      actions: typeof w.__laya?.writeText === "function" ? "present" : "absent",
      build: w.__laya_build ?? null,
      generation: typeof w.__laya?.generation === "number" ? w.__laya.generation : null,
    };
  });
}
