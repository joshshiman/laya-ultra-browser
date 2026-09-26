/**
 * Round trips to the renderer are a budget, not a detail.
 *
 * Every `page.evaluate` is a CDP round trip that also forces the renderer to run
 * script, and the occlusion check inside the walker calls getComputedStyle and
 * elementFromPoint, which forces style and layout recalculation. So the number of
 * evaluates per tool call is a direct contributor to per-action latency, and it is the
 * thing most easily regressed by a well-meaning "let me just check one more thing".
 *
 * This asserts the budget rather than reporting a number, so a change that quietly
 * doubles the cost of every action fails the suite.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { getPage, release } from "../../src/browser.js";
import { forgetInjection } from "../../src/inject.js";
import { clickDeep, isFresh, snapshot, writeText } from "../../src/page.js";
import { resolveTarget } from "../../src/select.js";
import { repoPath } from "../support/paths.js";

const fixtureUrl = pathToFileURL(repoPath("test/fixtures/shadow-lab.html")).href;

/**
 * Counts page.evaluate calls.
 *
 * Counting the wrapper rather than a CDP proxy keeps this fast and hermetic; the
 * renderer round trip is one-to-one with the evaluate.
 */
function countEvaluates<T extends { evaluate: (...a: never[]) => unknown }>(page: T) {
  const real = page.evaluate.bind(page);
  let calls = 0;
  (page as { evaluate: unknown }).evaluate = (...args: never[]) => {
    calls += 1;
    return (real as (...a: never[]) => unknown)(...args);
  };
  return {
    take: () => {
      const n = calls;
      calls = 0;
      return n;
    },
  };
}

describe("renderer round trips per tool call", () => {
  before(async () => {
    const page = await getPage();
    await page.goto(fixtureUrl, { waitUntil: "load" });
    await page.waitForTimeout(400);
  });

  after(async () => {
    await release();
  });

  it("snapshots in one round trip", async () => {
    const page = await getPage();
    const counter = countEvaluates(page);
    await snapshot(page, { interactive: true });
    assert.equal(
      counter.take(),
      1,
      "a snapshot is one page.evaluate; anything more means the injection probe is " +
        "running again, which is pure overhead once the layer is installed",
    );
  });

  it("writes by ref in one round trip, guard included", async () => {
    // The freshness guard runs inside the action's own evaluate, so the happy path does
    // not pay for a separate isFresh call.
    const page = await getPage();
    const counter = countEvaluates(page);
    const result = await writeText(page, { ref: 2 }, "budget", { requireFreshRef: true });
    assert.equal(result.ok, true, `write failed: ${String(result.reason)}`);
    assert.equal(
      counter.take(),
      1,
      "a ref write with the in-evaluate guard should be a single round trip",
    );
  });

  it("clicks by ref in one round trip, guard included", async () => {
    const page = await getPage();
    const counter = countEvaluates(page);
    const result = await clickDeep(page, { ref: 1 }, { requireFreshRef: true });
    assert.equal(result.ok, true, `click failed: ${String(result.reason)}`);
    assert.equal(counter.take(), 1, "a ref click with the in-evaluate guard should be one round trip");
  });

  it("resolves a goal in one round trip when Laya is not consulted", async () => {
    const page = await getPage();
    const counter = countEvaluates(page);
    await resolveTarget({ page, goal: "the LIGHT_INPUT field", deterministic: true });
    assert.equal(
      counter.take(),
      1,
      "resolveTarget walks the page once; browser_find used to walk it a second time " +
        "just to annotate two fields it already had",
    );
  });

  it("re-probes after a navigation, because the document changed", async () => {
    // The injection confirmation is cached per page, so the only thing that keeps it
    // honest is invalidating on navigation. If this regressed, a tool would run against
    // a document whose layer was never installed and fail with "window.__laya undefined".
    const page = await getPage();
    await snapshot(page, { interactive: true });
    const warm = countEvaluates(page);
    await snapshot(page, { interactive: true });
    assert.equal(warm.take(), 1, "steady state should not re-probe");

    await page.goto(fixtureUrl, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const afterNav = countEvaluates(page);
    await snapshot(page, { interactive: true });
    assert.equal(
      afterNav.take(),
      1,
      "after a navigation the layer is reinstalled by the init script, so one evaluate " +
        "should still be enough",
    );
  });

  it("re-probes when the caller says the document changed", async () => {
    // Two here, not one, and that is deliberate. isFresh is a read-only helper and
    // keeps the simpler ensureInjected-then-evaluate shape; with the confirmation cached
    // that is one round trip in steady state, and two only when something has told it
    // the document changed. The action path folds the check in and stays at one.
    const page = await getPage();
    await snapshot(page, { interactive: true });
    forgetInjection(page);
    const counter = countEvaluates(page);
    const result = await isFresh(page, 1);
    assert.equal(typeof result, "boolean");
    assert.equal(
      counter.take(),
      2,
      "forgetInjection should force a re-probe, and the read-only helpers pay it as a " +
        "separate evaluate rather than folding it in",
    );

    // And it must be a one-off, not a permanent re-probe on every call.
    const steady = countEvaluates(page);
    await isFresh(page, 1);
    assert.equal(steady.take(), 1, "after the re-probe the confirmation is cached again");
  });

  it("pays a second round trip only when a ref is actually stale", async () => {
    // The reason a ref went stale is worked out on the failure path. Confirming the
    // happy path stays at one is the point; a stale ref costing two is the trade.
    const page = await getPage();
    const counter = countEvaluates(page);
    const result = await writeText(page, { ref: 9999 }, "x", { requireFreshRef: true });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "stale");
    assert.equal(counter.take(), 1, "the guard alone should answer, with no extra round trip");
  });
});
