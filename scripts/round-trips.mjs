/**
 * Reports renderer round trips per MCP tool call, by driving the real modules the way
 * server.ts does.
 *
 * Kept separate from the suite because it is a report, not an assertion. The budget is
 * enforced in test/browser/round-trips.test.ts; this exists so the number can be seen
 * and compared over time.
 *
 * Usage: node scripts/round-trips.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { getPage, release } = await import(pathToFileURL(join(root, "dist/browser.js")).href);
const { snapshot, writeText, clickDeep } = await import(pathToFileURL(join(root, "dist/page.js")).href);
const { resolveTarget } = await import(pathToFileURL(join(root, "dist/select.js")).href);

const fixture = pathToFileURL(join(root, "test/fixtures/shadow-lab.html")).href;
const profile = mkdtempSync(join(tmpdir(), "laya-round-trips-"));

function countEvaluates(page) {
  const real = page.evaluate.bind(page);
  let calls = 0;
  page.evaluate = (...a) => {
    calls += 1;
    return real(...a);
  };
  return { take: () => { const n = calls; calls = 0; return n; } };
}

const rows = [];
async function measure(name, fn) {
  const page = await getPage();
  const counter = countEvaluates(page);
  const t0 = performance.now();
  let error = null;
  try {
    await fn(page);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  rows.push({ name, evaluates: counter.take(), ms: performance.now() - t0, error });
}

try {
  const page = await getPage();
  await page.goto(fixture, { waitUntil: "load" });
  await page.waitForTimeout(400);

  await measure("first call after navigation", (p) => snapshot(p, { interactive: true }));
  await measure("browser_snapshot", (p) => snapshot(p, { interactive: true }));
  await measure("browser_write_text by ref", (p) => writeText(p, { ref: 2 }, "x", { requireFreshRef: true }));
  await measure("browser_click by ref", (p) => clickDeep(p, { ref: 1 }, { requireFreshRef: true }));
  await measure("browser_find (deterministic)", (p) => resolveTarget({ page: p, goal: "the LIGHT_INPUT field", deterministic: true }));

  console.log("\nrenderer round trips per tool call\n");
  console.log("  " + "tool".padEnd(32) + "evaluates".padStart(10) + "ms".padStart(9));
  for (const r of rows) {
    const flag = r.error ? "  (error: " + r.error.slice(0, 40) + ")" : "";
    console.log("  " + r.name.padEnd(32) + String(r.evaluates).padStart(10) + r.ms.toFixed(1).padStart(9) + flag);
  }
  console.log("");
} finally {
  await release();
  rmSync(profile, { recursive: true, force: true });
}
