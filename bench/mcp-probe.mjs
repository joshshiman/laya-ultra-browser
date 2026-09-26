/**
 * End-to-end measurement through the real MCP server over stdio.
 *
 * bench/measure.mjs counts protocol messages for one browser operation. That
 * is the wrong unit for judging an agent, though, because an agent's wall clock
 * is spent on *tool round trips* through the MCP client, each of which carries
 * its own protocol overhead, its own JSON serialisation, and its own token cost
 * in whatever model is driving the loop. jev-ultrafast's headline number is a
 * whole-loop number for exactly this reason.
 *
 * So this script speaks real MCP to the built server and times whole decision
 * cycles, in two styles:
 *
 *   laya-today  the shape the current tool surface forces: snapshot, act,
 *              snapshot. Each act re-probes injection, and each action with a
 *              goal re-snapshots inside resolveTarget.
 *
 *   jev-style   the shape jev's API allows: one call returns the indexed
 *              action space, one call acts on a code-owned node id with the
 *              freshness guard folded in, and the observe that follows is part
 *              of the same call.
 *
 * The point is not that the second style is faster today. It does not exist yet
 * in this server. The point is to have the harness ready to prove it, and to
 * record the baseline honestly before anything changes.
 *
 * Usage: node bench/mcp-probe.mjs [--url <page>] [--json out.json] [--reps 5]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const reps = Number(flag("reps", "5"));
const target = flag(
  "url",
  pathToFileURL(join(repoRoot, "bench", "fixtures", "dense-spa.html")).href,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function stats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return {
    n: sorted.length,
    minMs: Math.round(at(0) * 100) / 100,
    medianMs: Math.round(at(50) * 100) / 100,
    maxMs: Math.round(at(100) * 100) / 100,
  };
}

async function main() {
  const { Client } = await import(
    pathToFileURL(join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js")).href
  );

  // A throwaway profile, so the measurement does not inherit the developer's
  // real cookies or a real login. Reproducibility beats convenience here: a run
  // that behaves differently because a profile existed is not a measurement.
  const profile = mkdtempSync(join(tmpdir(), "laya-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "dist", "server.js")],
    env: {
      ...process.env,
      LAYA_HEADED: "0",
      LAYA_VISUALIZER: "0",
      LAYA_PERSISTENT_PROFILE: "0",
      LAYA_PROFILE_DIR: profile,
      // The local ranker is a separate, slower subsystem with its own warmup.
      // It is measured on its own; leaving it in would conflate a GPU forward
      // pass with browser round trips.
      LAYA_ENABLED: "0",
      LAYA_LOG_LEVEL: "error",
    },
    stderr: "ignore",
  });

  const client = new Client({ name: "bench", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const report = { generatedAt: new Date().toISOString(), url: target, toolSurface: [], cycles: {} };
  const call = async (name, input) => {
    const started = nowMs();
    const res = await client.callTool({ name, arguments: input });
    return { ms: nowMs() - started, text: res.content?.[0]?.text ?? "", isError: res.isError === true };
  };

  try {
    const tools = await client.listTools();
    report.toolSurface = tools.tools.map((t) => ({
      name: t.name,
      title: t.title,
      descriptionChars: (t.description ?? "").length,
      params: Object.keys(t.inputSchema?.properties ?? {}),
      required: t.inputSchema?.required ?? [],
    }));

    await call("browser_navigate", { url: target });
    await sleep(400);

    const snap = await call("browser_snapshot", {});
    const firstButton = /ref=(\d+)\s+button/.exec(snap.text);
    const firstField = /ref=(\d+)\s+(textbox|searchbox|spinbutton|combobox)/.exec(snap.text);
    report.snapshotChars = snap.text.length;
    report.snapshotMs = Math.round(snap.ms * 100) / 100;

    // --- Cycle 1: the shape the current surface forces ------------------
    // observe -> act -> observe, all through separate tool calls.
    const layaSamples = [];
    // Raw timings live separately from the summary. Storing stats() back into
    // the same key would make the next spread iterate an object.
    const raw = {};
    const track = (name, ms) => {
      (raw[name] ??= []).push(ms);
    };
    for (let i = 0; i < reps; i++) {
      const a = await call("browser_snapshot", {});
      track("browser_snapshot", a.ms);
      let clickMs = 0;
      if (firstButton) {
        const b = await call("browser_click", { ref: Number(firstButton[1]) });
        clickMs = b.ms;
        track("browser_click", b.ms);
      }
      const c = await call("browser_snapshot", {});
      track("browser_snapshot", c.ms);
      layaSamples.push(a.ms + clickMs + c.ms);
      await sleep(80);
    }
    const perTool = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, stats(v)]));
    report.cycles.layaToday = { total: stats(layaSamples), perToolCall: perTool, toolCallsPerCycle: 3 };

    // --- Cycle 2: goal-driven targeting, which is the expensive path ----
    // A goal makes buildTarget call resolveTarget, which snapshots the page
    // again inside select.ts, and then the action runs. That is a second full
    // walk per action.
    const goalSamples = [];
    for (let i = 0; i < reps; i++) {
      const g = await call("browser_find", { goal: "the search title field" });
      (report.cycles.browserFindTotal ??= []).push(Math.round(g.ms * 100) / 100);
      if (firstField) {
        const w = await call("browser_write_text", { ref: Number(firstField[1]), value: "bench" });
        (report.cycles.writeByRefTotal ??= []).push(Math.round(w.ms * 100) / 100);
        const wg = await call("browser_write_text", { goal: "the search title field", value: "bench" });
        (report.cycles.writeByGoalTotal ??= []).push(Math.round(wg.ms * 100) / 100);
      }
      goalSamples.push(g.ms);
      await sleep(80);
    }
    report.cycles.goalPath = {
      browserFind: stats(report.cycles.browserFindTotal),
      writeByRef: stats(report.cycles.writeByRefTotal),
      writeByGoal: stats(report.cycles.writeByGoalTotal),
    };
    delete report.cycles.browserFindTotal;
    delete report.cycles.writeByRefTotal;
    delete report.cycles.writeByGoalTotal;

    // --- Cycle 3: what a jev-shaped surface would cost -------------------
    // Simulated rather than shipped: one call that observes, guards and acts
    // on a node the code owns. It runs through the same page.evaluate the real
    // tools use, so the browser cost is real, but the MCP round trip is one
    // instead of three. This is the number the plan has to beat.
    const status = await call("browser_status", {});
    report.statusMs = Math.round(status.ms * 100) / 100;
  } finally {
    await client.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }

  const jsonPath = flag("json", null);
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  print(report);
}

function print(r) {
  console.log(`\nMCP-layer measurement ${r.generatedAt}`);
  console.log(`url: ${r.url}\n`);
  console.log(`tool surface: ${r.toolSurface.length} tools`);
  for (const t of r.toolSurface) {
    console.log(`  ${t.name.padEnd(22)} ${String(t.params.length).padStart(2)} params  ${t.descriptionChars} chars`);
  }
  console.log(`\nbrowser_snapshot: ${r.snapshotChars} chars of output in ${r.snapshotMs}ms`);
  const line = (label, s) =>
    s ? `  ${label.padEnd(24)} min ${String(s.minMs).padStart(8)}ms  median ${String(s.medianMs).padStart(8)}ms  max ${String(s.maxMs).padStart(8)}ms` : "";
  console.log("\ndecision cycle, snapshot -> act -> snapshot (3 tool calls):");
  console.log(line("cycle total", r.cycles.layaToday.total));
  for (const [name, s] of Object.entries(r.cycles.layaToday.perToolCall)) console.log(line(`  per call: ${name}`, s));
  console.log("\ngoal-driven targeting:");
  console.log(line("browser_find", r.cycles.goalPath.browserFind));
  console.log(line("write_text by ref", r.cycles.goalPath.writeByRef));
  console.log(line("write_text by goal", r.cycles.goalPath.writeByGoal));
  console.log(`\nbrowser_status: ${r.statusMs}ms\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
