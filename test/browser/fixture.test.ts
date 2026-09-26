/**
 * The conformance fixture, run in a real browser.
 *
 * This is the test that used to be a manual step: open test/fixtures/shadow-lab.html
 * by hand, paste the walker into the console, call window.__layaLab.run(), and read
 * the number. That worked, but nothing checked it, so the documented pass counts could
 * drift from reality without anyone noticing.
 *
 * Driving the fixture through the server's own browser and injection code does two
 * things at once: it asserts the in-page layer still behaves, and it exercises the
 * install-and-inject path that a user actually depends on. If injection breaks, this
 * fails before any assertion runs.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { release, getPage } from "../../src/browser.js";
import { ensureInjected, probeInjection } from "../../src/inject.js";
import { snapshot, writeText, clickDeep, selectOption, inspect, readValue } from "../../src/page.js";
import { repoPath } from "../support/paths.js";

// Resolved from the repository root, not from this file's location: the compiled tests
// live in dist-test/, where a relative path would miss the fixture entirely.
const fixtureUrl = pathToFileURL(repoPath("test/fixtures/shadow-lab.html")).href;

/** Documented pass counts. Lowered deliberately if a real regression is accepted. */
const EXPECTED_WALKER = 30;
const EXPECTED_ACTIONS = 42;

type LabResult = {
  passed: number;
  total: number;
  failures: Array<{ label: string; actual: unknown; expected: unknown }>;
  [k: string]: unknown;
};

declare global {
  interface Window {
    __layaLab?: { run?: () => LabResult; runActions?: () => LabResult };
  }
}

describe("shadow-lab conformance fixture", () => {
  before(async () => {
    const page = await getPage();
    await page.goto(fixtureUrl, { waitUntil: "load" });
    // Custom elements upgrade and attach shadow roots asynchronously; snapshotting
    // too early under-reports them and the run produces phantom failures.
    await page.waitForFunction(() => typeof window.__layaLab?.run === "function", undefined, {
      timeout: 10_000,
    });
    await page.waitForTimeout(500);
  });

  after(async () => {
    await release();
  });

  it("installs the in-page layer", async () => {
    const page = await getPage();
    const status = await ensureInjected(page);
    assert.equal(status.walker, "present");
    assert.equal(status.actions, "present");
  });

  it("is idempotent across re-injection", async () => {
    const page = await getPage();
    const before = await probeInjection(page);
    await ensureInjected(page);
    await ensureInjected(page);
    const after = await probeInjection(page);
    assert.equal(after.walker, "present");
    assert.equal(after.actions, "present");
    // Re-injection bumps the generation counter; what matters is that a second and
    // third install neither throw nor leave the layer half-applied.
    assert.ok((after.generation ?? 0) >= (before.generation ?? 0));
  });

  it(`walker: ${EXPECTED_WALKER}/${EXPECTED_WALKER} assertions`, async () => {
    const page = await getPage();
    const result = await page.evaluate(() => window.__layaLab!.run!());
    assert.deepEqual(
      result.failures,
      [],
      `walker failures:\n${result.failures.map((f) => `  ${f.label}: got ${JSON.stringify(f.actual)}`).join("\n")}`,
    );
    assert.equal(result.passed, EXPECTED_WALKER);
    assert.equal(result.total, EXPECTED_WALKER);
  });

  it(`actions: ${EXPECTED_ACTIONS}/${EXPECTED_ACTIONS} assertions`, async () => {
    const page = await getPage();
    const result = await page.evaluate(() => window.__layaLab!.runActions!());
    assert.deepEqual(
      result.failures,
      [],
      `action failures:\n${result.failures.map((f) => `  ${f.label}: got ${JSON.stringify(f.actual)}`).join("\n")}`,
    );
    assert.equal(result.passed, EXPECTED_ACTIONS);
    assert.equal(result.total, EXPECTED_ACTIONS);
  });

  it("piercing finds strictly more controls than a flat walk", async () => {
    const page = await getPage();
    const pierced = await snapshot(page, { interactive: true, includeCovered: true });
    const flat = await snapshot(page, { interactive: true, pierceShadow: false, pierceFrames: false });
    assert.ok(
      pierced.elements.length > flat.elements.length,
      `expected piercing to find more (${pierced.elements.length}) than a flat walk (${flat.elements.length})`,
    );
    assert.ok(pierced.stats.openShadowRootsEntered > 0, "fixture should contain open shadow roots");
  });
});

describe("verified writes over the injected layer", () => {
  before(async () => {
    const page = await getPage();
    await page.goto(fixtureUrl, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await ensureInjected(page);
  });

  after(async () => {
    await release();
  });

  it("writes through a component host to the real inner control", async () => {
    const page = await getPage();
    const result = await writeText(page, { css: "fake-lightning-input" }, "hello from the test");
    assert.equal(result.ok, true, `write failed: ${result.reason}`);
    assert.equal(result.verified, true, `write unverified: ${result.reason}`);
    assert.equal(result.valueAfter, "hello from the test");
    assert.equal(result.descendedToInnerNode, true);
    assert.equal(result.hostEchoedValue, false);
  });

  it("reports a real failure when the target does not exist", async () => {
    const page = await getPage();
    const result = await writeText(page, { css: "#definitely-not-here" }, "x");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "resolve");
    assert.ok(result.reason && result.reason.length > 0, "a failed resolve must explain itself");
  });

  it("refuses to write a disabled field", async () => {
    const page = await getPage();
    const result = await writeText(page, { css: "#disabled-input" }, "x");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "precheck");
    assert.match(String(result.reason), /disabled/i);
  });

  it("refuses to write a readonly field", async () => {
    const page = await getPage();
    const result = await writeText(page, { css: "#readonly-input" }, "x");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "precheck");
    assert.match(String(result.reason), /readOnly/i);
  });

  it("detects a host that echoes the value without the inner field taking it", async () => {
    // This is the exact hazard the whole layer exists for: a wrapper that accepts an
    // assigned value and echoes it back, so naive read-back verification passes while
    // the real control never changed. Forcing noDescend reproduces it deliberately.
    const page = await getPage();
    const result = await writeText(
      page,
      { css: "fake-lightning-input" },
      "should not verify",
      { noDescend: true },
    );
    assert.equal(result.verified, false, "an echo-only write must not report verified");
    assert.equal(result.hostEchoedValue, true);
    assert.match(String(result.reason), /echoed the value back/);
  });

  it("refuses to write text into a button rather than faking a verified write", async () => {
    // Regression test for the one failure mode read-back verification cannot catch.
    // Assigning .value to a <button> sets a plain expando: the value persists, so the
    // read-back matches and an unfixed layer reported "verified". A probabilistic
    // ranker picking a button for a field goal hit this in practice.
    const page = await getPage();
    const result = await writeText(page, { css: "#light-button" }, "not a field");
    assert.equal(result.ok, false, "a write into a button must not report ok");
    assert.equal(result.verified, undefined);
    assert.equal(result.stage, "precheck");
    assert.match(String(result.reason), /does not accept a text value/);
    // The reason has to point at the right tool, not just complain.
    assert.match(String(result.reason), /click|select_option/);
  });

  it("lists the real text fields when it refuses", async () => {
    // A refusal the agent cannot act on is nearly as bad as a wrong success.
    const page = await getPage();
    const result = await writeText(page, { css: "#light-button" }, "x");
    const candidates = result.textEntryCandidates as Array<{ id: string }> | undefined;
    assert.ok(Array.isArray(candidates), "expected textEntryCandidates on the refusal");
    assert.ok(candidates.length > 0, "expected at least one text field to suggest");
    assert.ok(
      candidates.some((c) => c.id === "light-input"),
      `expected light-input among ${JSON.stringify(candidates)}`,
    );
  });

  it("still writes to every kind of real text field", async () => {
    // The new precheck must not reject legitimate targets.
    const page = await getPage();
    for (const selector of ["#light-input", "#shadowed-input"]) {
      const result = await writeText(page, { css: selector }, `typed into ${selector}`);
      assert.equal(result.ok, true, `${selector}: ${String(result.reason)}`);
      assert.equal(result.verified, true, `${selector} did not verify`);
      assert.equal(result.valueAfter, `typed into ${selector}`);
    }
  });

  it("reads the current value back independently", async () => {
    const page = await getPage();
    await writeText(page, { css: "#light-input" }, "round trip");
    const value = await readValue(page, { css: "#light-input" });
    assert.equal(value, "round trip");
  });

  it("selects a native option and verifies it", async () => {
    const page = await getPage();
    const result = await selectOption(page, { css: "#light-select" }, "beta");
    assert.equal(result.ok, true, `select failed: ${result.reason}`);
    assert.equal(result.valueAfter, "beta");
  });

  it("explains that a component wrapper is not a native select", async () => {
    const page = await getPage();
    const result = await selectOption(page, { css: "fake-lightning-input" }, "beta");
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /listbox|native/i);
  });

  it("inspects without mutating", async () => {
    const page = await getPage();
    const before = await readValue(page, { css: "#light-input" });
    const info = await inspect(page, { css: "#light-input" });
    const after = await readValue(page, { css: "#light-input" });
    assert.equal(info.found, true);
    assert.equal(before, after, "inspect must not change the page");
  });

  it("clicks and reports what moved", async () => {
    const page = await getPage();
    const result = await clickDeep(page, { css: "#light-button" });
    assert.equal(result.ok, true, `click failed: ${result.reason}`);
    assert.equal(typeof result.urlChanged, "boolean");
  });
});

describe("browser lifecycle", () => {
  after(async () => {
    await release();
  });

  it("relaunches after the browser is released", async () => {
    // Regression test. Releasing the browser used to mark the process permanently
    // closed, so an idle timeout made every later tool call fail with "the server is
    // shutting down". Release has to leave the server able to launch again.
    const first = await getPage();
    await release();

    const second = await getPage();
    assert.notEqual(second, first, "expected a fresh page after release");
    const url = await second.evaluate(() => location.href);
    assert.equal(typeof url, "string");
  });

  it("re-injects into a page created after release", async () => {
    // A brand new page has no window.__laya until the ensure path installs it.
    const page = await getPage();
    await ensureInjected(page);
    const status = await probeInjection(page);
    assert.equal(status.walker, "present");
    assert.equal(status.actions, "present");
  });
});
