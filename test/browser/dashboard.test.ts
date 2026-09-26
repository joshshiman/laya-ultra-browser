/**
 * The dashboard's live behaviour, in a real browser.
 *
 * The dashboard's logic lives in a template string, so asserting the served HTML
 * contains a given function proves nothing about whether it runs. These drive the real
 * page over SSE and check what a person would actually see, including that the
 * in-flight card is retracted once a ranking lands rather than lingering forever.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { record, clear, type VisualizerEventInput } from "../../src/visualizer/events.js";
import { start, stop, url } from "../../src/visualizer/server.js";

const CANDIDATES = [
  { ref: 1, score: 0.62, role: "button", name: "Save" },
  { ref: 2, score: 0.21, role: "textbox", name: "Email address" },
  { ref: 3, score: 0.09, role: "textbox", name: "Confirm email" },
];

type RankInput = Extract<VisualizerEventInput, { kind: "rank" }>;

/** A completed ranking, with overrides for the cases that need a different goal. */
function rankEvent(over: Partial<RankInput> = {}): RankInput {
  return {
    kind: "rank",
    goal: "the email address field",
    mode: "choice",
    considered: CANDIDATES,
    pruned: 2,
    total: 9,
    selectedRef: 1,
    deterministicRef: 2,
    disagreedWithDeterministic: true,
    disagreementReason:
      "Laya chose ref 1 (Save); name and role matching chose ref 2 (Email address).",
    elapsedMs: 97,
    calibrated: false,
    ...over,
  };
}

describe("dashboard in a browser", () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    clear();
    await start({ enabled: true, port: 0 });
    browser = await chromium.launch({ channel: "chrome" });
    page = await browser.newPage();
    await page.goto(url(), { waitUntil: "domcontentloaded" });
    // Wait for the EventSource to connect, otherwise the first events race the stream.
    await page.waitForFunction(() => document.getElementById("conn")?.textContent === "live", undefined, {
      timeout: 10_000,
    });
  });

  after(async () => {
    await browser?.close();
    await stop();
  });

  it("shows a ranking with a bar per candidate", async () => {
    record(rankEvent());
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length >= 3);
    const rows = await page.locator("table tbody tr").count();
    assert.equal(rows, 3, "expected one row per candidate");
    const scores = await page.locator("table tbody td.val").allTextContents();
    assert.deepEqual(scores, ["0.620", "0.210", "0.090"]);
  });

  it("animates the bars to their measured width", async () => {
    // The transition has to end at the real value, not at an arbitrary full bar.
    await page.waitForFunction(() => {
      const f = document.querySelector("table tbody tr .fill") as HTMLElement | null;
      return f && f.style.width !== "";
    });
    const width = await page
      .locator("table tbody tr .fill")
      .first()
      .evaluate((el) => (el as HTMLElement).style.width);
    // The browser normalises "62.00%" to "62%", so compare numerically.
    assert.ok(
      Math.abs(parseFloat(width) - 62) < 0.01,
      `expected the top bar to settle at 62%, got ${width}`,
    );
  });

  it("surfaces the disagreement and names both picks", async () => {
    const text = await page.locator(".disagree").first().textContent();
    assert.match(text ?? "", /Disagreement/);
    assert.match(text ?? "", /ref 1 \(Save\)/);
    assert.match(text ?? "", /ref 2 \(Email address\)/);
  });

  it("marks the model-selected row", async () => {
    const picked = await page.locator("table tbody tr.picked").count();
    assert.equal(picked, 1, "exactly one row should be marked as selected");
    const ref = await page.locator("table tbody tr.picked td.ref").first().textContent();
    assert.match(ref ?? "", /ref 1/);
  });

  it("shows an in-flight card and retracts it when the ranking lands", async () => {
    record({ kind: "rank-pending", goal: "a pending goal", mode: "choice", candidateCount: 7, total: 12 });
    await page.waitForSelector(".card.pending");
    assert.match(await page.locator(".card.pending .scanning").textContent() ?? "", /scanning/);

    record(rankEvent({ goal: "a pending goal" }));
    // The retraction is the whole point: a card still claiming work is in flight after
    // the answer is on screen is worse than no in-flight state at all.
    await page.waitForFunction(() => document.querySelectorAll(".card.pending").length === 0, undefined, {
      timeout: 5_000,
    });
  });

  it("keeps an in-flight card for a goal that has not resolved", async () => {
    record({ kind: "rank-pending", goal: "still running", mode: "noul", candidateCount: 3, total: 3 });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".card.pending")).some(
          (c) => (c as HTMLElement).dataset.goal === "still running",
        ),
      undefined,
      { timeout: 5_000 },
    );
  });

  it("renders a failed write in red, never green", async () => {
    record({
      kind: "action",
      tool: "browser_write_text",
      target: "goal \"the email field\" -> ref 1",
      ok: false,
      verified: null,
      ref: 1,
      reason: "resolved to <button>, which does not accept a text value.",
      elapsedMs: 5,
    });
    await page.waitForSelector(".act.no");
    const header = await page.locator(".card .head .act").first();
    assert.match(await header.textContent() ?? "", /failed/);
    const color = await header.evaluate((el) => getComputedStyle(el).color);
    // The whole reason this tool exists is that failures look like successes elsewhere.
    assert.notEqual(color, "rgb(63, 185, 80)", "a failed action must not be rendered green");
  });

  it("counts failures in the header", async () => {
    const n = await page.locator("#nbad").textContent();
    assert.ok(Number(n) >= 1, `expected at least one failure counted, got ${n}`);
  });

  it("states that the scores are uncalibrated, on the page itself", async () => {
    const banner = await page.locator(".calib").textContent();
    assert.match(banner ?? "", /uncalibrated/i);
  });

  it("never exceeds its card cap", async () => {
    for (let i = 0; i < 60; i++) record(rankEvent({ goal: `flood ${i}` }));
    await page.waitForFunction(() => document.querySelectorAll("#feed > .card").length <= 40, undefined, {
      timeout: 10_000,
    });
    const count = await page.locator("#feed > .card").count();
    assert.ok(count <= 40, `feed grew to ${count} cards`);
  });
});
