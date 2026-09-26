/**
 * The dashboard must never execute page content.
 *
 * Element names, roles and failure reasons all originate in whatever page the browser
 * loaded, and the dashboard renders them into innerHTML. That is a stored-XSS surface:
 * a page that names a control `<img src=x onerror=...>` would run script in the
 * dashboard's origin, which is loopback on the operator's machine, next to a server that
 * can drive their browser and read a profile full of session cookies.
 *
 * Everything is escaped today. This exists so that stays true when someone adds a
 * field, because the failure is invisible in review and only shows up as a working
 * exploit.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { record, clear } from "../../src/visualizer/events.js";
import { start, stop, url } from "../../src/visualizer/server.js";

/** Payloads that execute if they are ever interpolated as markup. */
const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '"><svg onload="window.__pwned=1">',
  "'><iframe src=javascript:window.__pwned=1>",
  "<b>bold</b>",
  "</span></div><script>window.__pwned=1</script>",
];

describe("dashboard escaping", () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    clear();
    await start({ enabled: true, port: 0 });
    browser = await chromium.launch({ channel: "chrome" });
    page = await browser.newPage();
    await page.goto(url(), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("conn")?.textContent === "live", undefined, {
      timeout: 10_000,
    });
  });

  after(async () => {
    await browser?.close();
    await stop();
  });

  it("renders a hostile element name as text, not markup", async () => {
    record({
      kind: "rank",
      goal: PAYLOADS[0]!,
      mode: "choice",
      considered: [
        { ref: 1, score: 0.9, role: PAYLOADS[1]!, name: PAYLOADS[0]! },
        { ref: 2, score: 0.1, role: "textbox", name: PAYLOADS[2]! },
      ],
      pruned: 0,
      total: 2,
      selectedRef: 1,
      deterministicRef: 2,
      disagreedWithDeterministic: true,
      disagreementReason: `Laya chose ${PAYLOADS[3]!}; matching chose ${PAYLOADS[4]!}`,
      elapsedMs: 5,
      calibrated: false,
    });

    await page.waitForSelector("table tbody tr");
    // Give any injected handler a chance to fire before checking.
    await page.waitForTimeout(250);

    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
    assert.equal(pwned, undefined, "page content executed in the dashboard origin");

    // And the payload is present as literal text, so it is visible rather than dropped.
    const text = await page.locator("#feed").textContent();
    assert.ok(
      text?.includes("<img src=x"),
      "the hostile name should render as visible text, not be silently removed",
    );
  });

  it("renders a hostile failure reason as text", async () => {
    record({
      kind: "action",
      tool: "browser_write_text",
      target: PAYLOADS[0]!,
      ok: false,
      verified: null,
      ref: null,
      reason: PAYLOADS[5]!,
      elapsedMs: 1,
    });
    await page.waitForSelector(".act.no");
    await page.waitForTimeout(250);
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
    assert.equal(pwned, undefined, "a failure reason executed in the dashboard origin");
  });

  it("renders a hostile pending goal as text", async () => {
    record({
      kind: "rank-pending",
      goal: PAYLOADS[2]!,
      mode: "choice",
      candidateCount: 1,
      total: 1,
    });
    await page.waitForSelector(".card.pending");
    await page.waitForTimeout(250);
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
    assert.equal(pwned, undefined, "a pending goal executed in the dashboard origin");
  });

  it("injects no extra elements for a hostile name", async () => {
    // Counting nodes catches an escape that produces markup without executing it, which
    // the previous checks would miss.
    const before = await page.locator("#feed img, #feed script, #feed svg, #feed iframe").count();
    assert.equal(before, 0, "the feed should contain no injected media or script elements");
  });

  it("escapes the goal in a pending card's data attribute without breaking matching", async () => {
    // The retraction path keys on dataset.goal, so a quote in the goal must not break
    // the attribute or stop the later result from clearing the card.
    record({ kind: "rank-pending", goal: PAYLOADS[3]!, mode: "choice", candidateCount: 1, total: 1 });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".card.pending")).some(
          (c) => (c as HTMLElement).dataset.goal?.includes("javascript:"),
        ),
      undefined,
      { timeout: 5_000 },
    );
    record({
      kind: "rank",
      goal: PAYLOADS[3]!,
      mode: "choice",
      considered: [{ ref: 1, score: 1, role: "button", name: "x" }],
      pruned: 0,
      total: 1,
      selectedRef: 1,
      deterministicRef: 1,
      disagreedWithDeterministic: false,
      disagreementReason: null,
      elapsedMs: 1,
      calibrated: false,
    });
    await page.waitForFunction(
      () => !Array.from(document.querySelectorAll(".card.pending")).some((c) => (c as HTMLElement).dataset.goal?.includes("javascript:")),
      undefined,
      { timeout: 5_000 },
    );
  });
});
