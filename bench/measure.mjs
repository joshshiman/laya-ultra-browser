/**
 * Measurement harness for laya-ultra-browser.
 *
 * Purpose: turn "this should be faster" into numbers. It measures the two things
 * that actually decide whether a browser agent feels fast:
 *
 *   1. wall-clock latency of one observation and one action, and
 *   2. how many Chrome DevTools Protocol messages each of those costs.
 *
 * The second number is the one jev-ultrafast actually optimises for. Its README
 * reports median browser protocol calls falling 1,092 -> 101 while wall-clock
 * fell 25%, and the first figure moved far more than the second. A change that
 * makes the agent send one protocol message instead of forty is a bigger win
 * than one that shaves a millisecond of JavaScript, and only counting messages
 * tells you which you have done.
 *
 * Everything runs through cdp-proxy.mjs, so the counts are counted on the wire
 * and include the round trips Playwright makes internally. Nothing here is
 * imported by the server; it is a developer tool.
 *
 * Usage: node bench/measure.mjs [--pages fixture,shadow,live] [--json out.json]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCdpProxy } from "./cdp-proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const distDir = join(repoRoot, "dist");
const walkerSource = readFileSync(join(distDir, "snapshot", "walker.js"), "utf8");
const actionsSource = readFileSync(join(distDir, "snapshot", "actions.js"), "utf8");

const jevRef = join(repoRoot, "..", "_ref", "jev-ultrafast", "jev_ultrafast", "snapshot.js");
let jevSource = null;
try {
  jevSource = readFileSync(jevRef, "utf8");
} catch {
  console.error(`note: jev-ultrafast reference snapshot not found at ${jevRef}; skipping the comparison arm`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function summarize(samples) {
  return {
    n: samples.length,
    medianMs: percentile(samples.map((s) => s.ms), 50),
    p95Ms: percentile(samples.map((s) => s.ms), 95),
    minMs: percentile(samples.map((s) => s.ms), 0),
    maxMs: percentile(samples.map((s) => s.ms), 100),
    medianProtocol: percentile(samples.map((s) => s.protocol), 50),
    p95Protocol: percentile(samples.map((s) => s.protocol), 95),
  };
}

/**
 * Launches Chromium ourselves so there is a CDP endpoint to put a proxy in front
 * of. Playwright's own `chromium.launch` speaks over an anonymous pipe, and
 * there is no supported hook for counting what goes down it.
 */
async function launchChromium() {
  const { chromium } = await import("playwright");
  const dir = mkdtempSync(join(tmpdir(), "laya-bench-"));
  const userDataDir = join(dir, "profile");
  // Ask the OS for a free port by binding and releasing, which is good enough
  // for a local benchmark and avoids a retry loop around a guessed port.
  const upstreamPort = 9333 + Math.floor(Math.random() * 400);
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      `--remote-debugging-port=${upstreamPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // Poll /json/version rather than sleeping a fixed amount: on a cold cache the
  // browser can take a second, and a fixed sleep would either be too long on a
  // warm run or flaky on a cold one.
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const r = await fetch(`http://127.0.0.1:${upstreamPort}/json/version`);
      ready = r.ok;
    } catch {
      await sleep(50);
    }
  }
  if (!ready) {
    child.kill();
    throw new Error("Chromium did not expose a CDP endpoint within 20s");
  }
  return {
    upstreamPort,
    cleanup: async () => {
      child.kill();
      await sleep(100);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Counts CDP messages for the duration of one measured operation. */
async function measure(proxy, fn) {
  proxy.reset();
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const { protocolCalls } = proxy.report(0);
  return { ms, protocol: protocolCalls, value };
}

const PAGES = {
  fixture: {
    label: "local fixture (test/fixtures/shadow-lab.html)",
    url: pathToFileURL(join(repoRoot, "test", "fixtures", "shadow-lab.html")).href,
    expect: "shadow-DOM heavy, offline, deterministic",
  },
  dense: {
    label: "synthetic dense SPA (bench/fixtures/dense-spa.html)",
    url: pathToFileURL(join(repoRoot, "bench", "fixtures", "dense-spa.html")).href,
    expect: "generated component-heavy page, offline, deterministic",
  },
  wikipedia: {
    label: "live: Wikipedia article",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    expect: "real network, very large DOM, lots of text",
    live: true,
  },
  github: {
    label: "live: github.com",
    url: "https://github.com/",
    expect: "real network, component heavy, custom elements",
    live: true,
  },
};

async function run() {
  const { chromium } = await import("playwright");
  const { upstreamPort, cleanup } = await launchChromium();
  const proxy = await startCdpProxy({ upstreamPort, proxyPort: upstreamPort + 500 });
  const browser = await chromium.connectOverCDP(proxy.endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await context.setDefaultTimeout(30_000);

  const report = { generatedAt: new Date().toISOString(), pages: {}, notes: [] };

  try {
    for (const [key, spec] of Object.entries(PAGES)) {
      if (spec.live && !args.includes("--live")) continue;
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      const entry = { label: spec.label, url: spec.url, note: spec.expect };

      // Install the server's own in-page layer, exactly as init scripts do.
      await page.addInitScript({ content: walkerSource });
      await page.addInitScript({ content: actionsSource });
      await page.goto(spec.url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
      await sleep(300);

      entry.dom = await page.evaluate(() => ({
        nodes: document.querySelectorAll("*").length,
        shadowHosts: [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length,
      }));

      // --- Arm A: the laya snapshot, as the server calls it -------------
      const opts = { interactive: true, includeUrls: true, maxElements: 400 };
      const layaSamples = [];
      for (let i = 0; i < 7; i++) {
        const s = await measure(proxy, () => page.evaluate((o) => window.__laya.snapshot(o), opts));
        layaSamples.push(s);
        if (i === 0) {
          entry.layaElements = s.value.elements.length;
          entry.layaStats = {
            visited: s.value.stats.visited,
            interactiveFound: s.value.stats.interactiveFound,
            emitted: s.value.stats.emitted,
            fromShadow: s.value.stats.fromShadow,
            skippedOffscreen: s.value.stats.skippedOffscreen,
            skippedCovered: s.value.stats.skippedCovered,
          };
        }
        await sleep(40);
      }
      entry.layaSnapshot = summarize(layaSamples);
      entry.layaSnapshot.protocolBreakdown = proxy.report(8).clientToBrowser.top;

      // --- Arm B: the jev-ultrafast snapshot, same page ------------------
      if (jevSource) {
        const jevSamples = [];
        let jevElements = 0;
        let jevText = 0;
        for (let i = 0; i < 7; i++) {
          const s = await measure(proxy, () => page.evaluate(jevSource));
          jevSamples.push(s);
          if (i === 0) {
            jevElements = s.value?.actions?.length ?? 0;
            jevText = s.value?.text?.length ?? 0;
          }
          await sleep(40);
        }
        entry.jevSnapshot = summarize(jevSamples);
        entry.jevSnapshot.elements = jevElements;
        entry.jevSnapshot.textChars = jevText;
        entry.jevSnapshot.protocolBreakdown = proxy.report(8).clientToBrowser.top;
      }

      // --- A full decision cycle in each style --------------------------
      // jev: one observe -> one act -> one observe.
      // laya today: probe -> snapshot -> isFresh -> act -> probe -> snapshot.
      const firstField = await page.evaluate((o) => {
        const s = window.__laya.snapshot(o);
        return s.elements.find((e) => /textbox|searchbox|spinbutton|combobox/.test(e.role))?.ref ?? null;
      }, opts);
      const firstClickable = await page.evaluate((o) => {
        const s = window.__laya.snapshot(o);
        return s.elements.find((e) => e.role === "button" || e.role === "link")?.ref ?? null;
      }, opts);

      if (firstField) {
        const cycles = [];
        for (let i = 0; i < 5; i++) {
          cycles.push(
            await measure(proxy, async () => {
              // what buildTarget + writeText actually costs today
              const fresh = await page.evaluate(
                (r) => window.__laya.fresh(r),
                firstField,
              );
              if (!fresh) return "stale";
              const res = await page.evaluate(
                (a) => window.__laya.writeText(a.target, "benchmark", {}),
                { target: { ref: firstField } },
              );
              return res.verified;
            }),
          );
          await sleep(40);
        }
        entry.layaWriteCycle = summarize(cycles);
      }

      if (jevSource && firstClickable !== null) {
        const cycles = [];
        for (let i = 0; i < 5; i++) {
          cycles.push(
            await measure(proxy, async () => {
              const state = await page.evaluate(jevSource);
              const action = state?.actions?.find((a) => a.kind === "click");
              if (!action) return "no-action";
              // the freshness guard jev runs immediately before input
              const ok = await page.evaluate(
                (a) => {
                  const c = window.__jevFast;
                  const e = c?.nodes.get(a.node);
                  if (!e?.isConnected || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                    return false;
                  }
                  const r = e.getBoundingClientRect();
                  const x = r.x + r.width / 2;
                  const y = r.y + r.height / 2;
                  return e.contains(document.elementFromPoint(x, y));
                },
                action,
              );
              return ok;
            }),
          );
          await sleep(40);
        }
        entry.jevObserveGuardCycle = summarize(cycles);
      }

      // --- The duplicate-snapshot cost in browser_find ------------------
      // browser_find calls resolveTarget (which snapshots) and then snapshots
      // again to annotate the alternatives. This measures that second pass.
      // Sequential on purpose: the counter is shared state, so overlapping
      // measurements would attribute one operation's protocol calls to another.
      const findSamples = [];
      for (let i = 0; i < 5; i++) {
        findSamples.push(
          await measure(proxy, async () => {
            const a = await page.evaluate((o) => window.__laya.snapshot(o), opts);
            const b = await page.evaluate((o) => window.__laya.snapshot(o), opts);
            return [a.elements.length, b.elements.length];
          }),
        );
        await sleep(30);
      }
      entry.browserFindDoubleSnapshot = summarize(findSamples);

      // --- ensureInjected probe cost ------------------------------------
      // Every tool call goes through ensureInjected, which evaluates a probe
      // before the real work. That probe is pure overhead on a warm page.
      const probeSamples = [];
      for (let i = 0; i < 5; i++) {
        probeSamples.push(
          await measure(proxy, () =>
            page.evaluate(() => ({
              hasWalker: typeof window.__laya?.snapshot === "function",
              hasActions: typeof window.__laya?.writeText === "function",
              build: window.__laya_build ?? null,
              generation: typeof window.__laya?.generation === "number" ? window.__laya.generation : null,
            })),
          ),
        );
        await sleep(30);
      }
      entry.injectProbe = summarize(probeSamples);

      report.pages[key] = entry;
      await page.close();
    }
  } finally {
    await proxy.close();
    await browser.close().catch(() => {});
    await cleanup();
  }

  const jsonPath = flag("json", null);
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
}

function printReport(report) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nmeasured ${report.generatedAt}\n`);
  for (const [key, p] of Object.entries(report.pages)) {
    console.log(`== ${key}: ${p.label}`);
    console.log(`   ${p.url}  (${p.note})`);
    if (p.dom) console.log(`   dom: ${p.dom.nodes} nodes, ${p.dom.shadowHosts} open shadow roots`);
    if (p.layaStats) {
      console.log(
        `   walker: visited ${p.layaStats.visited}, interactive ${p.layaStats.interactiveFound}, emitted ${p.layaStats.emitted}, from shadow ${p.layaStats.fromShadow}, skipped offscreen ${p.layaStats.skippedOffscreen}, covered ${p.layaStats.skippedCovered}`,
      );
    }
    const row = (label, s) => {
      if (!s) return;
      console.log(
        `   ${pad(label, 26)} median ${pad(`${s.medianMs}ms`, 10)} p95 ${pad(`${s.p95Ms}ms`, 10)} median protocol calls ${s.medianProtocol}`,
      );
    };
    row("laya snapshot", p.layaSnapshot);
    if (p.layaSnapshot) console.log(`      emitted ${p.layaSnapshot ? p.layaElements : "?"} elements`);
    row("jev snapshot", p.jevSnapshot);
    if (p.jevSnapshot) console.log(`      indexed ${p.jevSnapshot.elements} actions, ${p.jevSnapshot.textChars} text chars`);
    row("laya write cycle", p.layaWriteCycle);
    row("jev observe+guard cycle", p.jevObserveGuardCycle);
    row("browser_find 2 snapshots", p.browserFindDoubleSnapshot);
    row("ensureInjected probe", p.injectProbe);
    if (p.layaSnapshot?.protocolBreakdown) {
      console.log(`      laya top protocol methods: ${p.layaSnapshot.protocolBreakdown.map((r) => `${r.method}=${r.count}`).join(" ")}`);
    }
    if (p.jevSnapshot?.protocolBreakdown) {
      console.log(`      jev  top protocol methods: ${p.jevSnapshot.protocolBreakdown.map((r) => `${r.method}=${r.count}`).join(" ")}`);
    }
    console.log("");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
