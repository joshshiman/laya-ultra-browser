/**
 * Typed access to window.__laya.
 *
 * The in-page layer is plain JS and untyped by design, so every shape crossing this
 * boundary is declared here. That way a change to walker.js or actions.js surfaces as
 * a type error at the call site rather than as `undefined` inside a tool result at
 * runtime.
 */
import type { Page } from "playwright";
import { ensureInjected } from "./inject.js";

export type SnapshotOptions = {
  interactive?: boolean;
  includeUrls?: boolean;
  includeOffscreen?: boolean;
  includeCovered?: boolean;
  maxElements?: number;
  maxDepth?: number;
  pierceShadow?: boolean;
  pierceFrames?: boolean;
  selector?: string;
  withPaths?: boolean;
};

export type SnapshotElement = {
  ref: number;
  role: string;
  tag: string;
  name: string;
  value: string;
  disabled: boolean;
  shadowDepth: number;
  frameDepth: number;
  visibility: "clear" | "covered" | "offscreen" | "unknown";
  box: { x: number; y: number; w: number; h: number };
  topBox?: { x: number; y: number; w: number; h: number };
  href?: string;
  options?: Array<{ index: number; label: string }>;
  path?: string;
};

export type SnapshotStats = {
  generation: number;
  visited: number;
  interactiveFound: number;
  emitted: number;
  skippedOffscreen: number;
  skippedCovered: number;
  skippedHidden: number;
  openShadowRootsEntered: number;
  maxShadowDepth: number;
  fromShadow: number;
  suspectedClosedShadowRoots: number;
  suspectedClosedHosts: string[];
  sameOriginFramesEntered: number;
  crossOriginFramesBlocked: number;
  crossOriginFrameUrls: string[];
  truncated: boolean;
};

export type SnapshotResult = {
  elements: SnapshotElement[];
  stats: SnapshotStats;
  meta: {
    url: string;
    title: string;
    viewport: { w: number; h: number };
    readyState: string;
    generation: number;
    walkerVersion: string;
  };
  error?: string;
};

export type ResolvedElement = {
  tag: string;
  type: string;
  id: string;
  ariaLabel: string;
  shadowDepth: number;
  hostChain: string;
  box: { x: number; y: number; w: number; h: number } | null;
  disabled: boolean;
  readOnly: boolean;
};

/**
 * A write result. `verified` is the load-bearing field: it is true only when the
 * value was read back off the real inner control and matched. A write that silently
 * did nothing reports verified:false, which is the entire reason this layer exists.
 */
export type WriteResult = {
  ok: boolean;
  verified?: boolean;
  stage: "resolve" | "precheck" | "act" | "verify" | "done";
  reason: string | null;
  /** Text fields offered when a write was refused for resolving to a non-field. */
  textEntryCandidates?: Array<{ tag: string; id: string; name: string; value?: string | null }>;
  hostEchoedValue?: boolean;
  valueBefore?: string | null;
  valueAfter?: string | null;
  writtenNodeReports?: string;
  verifiedOn?: ResolvedElement;
  descendedToInnerNode?: boolean;
  hostTag?: string | null;
  setterUsed?: string;
  eventsFired?: string[];
  focused?: boolean;
  element?: ResolvedElement;
  ambiguous?: boolean;
  candidates?: number;
};

export type ClickResult = {
  ok: boolean;
  stage: string;
  note?: string;
  reason?: string | null;
  descendedToInnerNode?: boolean;
  hostTag?: string | null;
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  bodyChildrenBefore: number;
  bodyChildrenAfter: number;
  element?: ResolvedElement;
  ambiguous?: boolean;
};

export type SelectResult = {
  ok: boolean;
  verified?: boolean;
  stage: string;
  reason: string | null;
  selectedIndex?: number;
  valueAfter?: string | null;
  eventsFired?: string[];
  options?: string[];
  element?: ResolvedElement;
};

export type InspectResult = {
  found: boolean;
  reason?: string;
  candidates?: number;
  matchedBy?: string;
  ambiguous?: boolean;
  matched?: ResolvedElement;
  innerFocusable?: ResolvedElement | null;
  wouldDescend?: boolean;
  currentValue?: string | null;
  visible?: boolean;
  reachableByQuerySelector?: boolean | string;
};

/** Target spec understood by the in-page resolver. */
export type Target = {
  ref?: number;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  role?: string;
  css?: string;
  index?: number;
  exact?: boolean;
};

export async function snapshot(page: Page, opts: SnapshotOptions): Promise<SnapshotResult> {
  await ensureInjected(page);
  return page.evaluate((o: SnapshotOptions) => {
    const w = window as unknown as { __laya: { snapshot: (x: unknown) => SnapshotResult } };
    return w.__laya.snapshot(o);
  }, opts) as Promise<SnapshotResult>;
}

export async function writeText(
  page: Page,
  target: Target,
  value: string,
  opts: { noDescend?: boolean; scroll?: boolean } = {},
): Promise<WriteResult> {
  await ensureInjected(page);
  return page.evaluate(
    (a: { target: Target; value: string; opts: { noDescend?: boolean; scroll?: boolean } }) => {
      const w = window as unknown as {
        __laya: { writeText: (t: Target, v: string, o: unknown) => WriteResult };
      };
      return w.__laya.writeText(a.target, a.value, a.opts);
    },
    { target, value, opts },
  );
}

export async function clickDeep(
  page: Page,
  target: Target,
  opts: { noDescend?: boolean; scroll?: boolean } = {},
): Promise<ClickResult> {
  await ensureInjected(page);
  return page.evaluate(
    (a: { target: Target; opts: { noDescend?: boolean; scroll?: boolean } }) => {
      const w = window as unknown as {
        __laya: { clickDeep: (t: Target, o: unknown) => ClickResult };
      };
      return w.__laya.clickDeep(a.target, a.opts);
    },
    { target, opts },
  );
}

export async function selectOption(
  page: Page,
  target: Target,
  value: string,
  opts: { noDescend?: boolean } = {},
): Promise<SelectResult> {
  await ensureInjected(page);
  return page.evaluate(
    (a: { target: Target; value: string; opts: { noDescend?: boolean } }) => {
      const w = window as unknown as {
        __laya: { selectOption: (t: Target, v: string, o: unknown) => SelectResult };
      };
      return w.__laya.selectOption(a.target, a.value, a.opts);
    },
    { target, value, opts },
  );
}

export async function inspect(page: Page, target: Target): Promise<InspectResult> {
  await ensureInjected(page);
  return page.evaluate((t: Target) => {
    const w = window as unknown as { __laya: { inspect: (x: Target) => InspectResult } };
    return w.__laya.inspect(t);
  }, target);
}

export async function readValue(page: Page, target: Target): Promise<string | null> {
  await ensureInjected(page);
  return page.evaluate((t: Target) => {
    const w = window as unknown as { __laya: { readValue: (x: Target) => string | null } };
    return w.__laya.readValue(t);
  }, target);
}

/** Confirms a ref from an earlier snapshot still points at a usable node. */
export async function isFresh(page: Page, ref: number): Promise<boolean> {
  await ensureInjected(page);
  return page.evaluate((r: number) => {
    const w = window as unknown as { __laya: { fresh: (x: number) => boolean } };
    return w.__laya.fresh(r);
  }, ref);
}

/**
 * Explains why a ref is not usable, in the caller's terms.
 *
 * `fresh()` collapses three different problems into one boolean: the node is gone, it
 * is not rendered, or it is occluded. Only the first is fatal for a write, and each
 * needs a different response, so the reason is worth the extra round trip.
 */
export async function probeRef(page: Page, ref: number): Promise<string> {
  await ensureInjected(page);
  return page.evaluate((r: number) => {
    const w = window as unknown as {
      __laya: { resolve: (x: number) => Element | null };
    };
    const el = w.__laya.resolve(r);
    if (!el) return "the node is no longer in the document";

    const view = el.ownerDocument?.defaultView ?? window;
    let rect: DOMRect | null = null;
    let rendered = false;
    try {
      rect = el.getBoundingClientRect();
      const style = view.getComputedStyle(el);
      rendered =
        !!style &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        parseFloat(style.opacity || "1") > 0 &&
        (rect.width > 0 || rect.height > 0);
    } catch {
      rendered = false;
    }
    if (!rendered) return "it is hidden, collapsed or has zero size";

    if (rect) {
      const vw = view.innerWidth || el.ownerDocument?.documentElement.clientWidth || 1;
      const vh = view.innerHeight || el.ownerDocument?.documentElement.clientHeight || 1;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) {
        return "it is scrolled out of view";
      }
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), vw - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), vh - 1);
      let hit: Element | null = null;
      try {
        hit = el.ownerDocument?.elementFromPoint(x, y) ?? null;
      } catch {
        hit = null;
      }
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        return "something is covering it, so a click would land on the wrong element";
      }
    }
    return "it changed since the snapshot was taken";
  }, ref);
}
