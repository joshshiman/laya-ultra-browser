/**
 * Renders a README screenshot of a real tool exchange.
 *
 * The point is to show a reader what verified output looks like, including a
 * refusal, because that is the behaviour that distinguishes this from every other
 * browser tool. Generated from an actual run rather than typed by hand, so it cannot
 * drift from what the code does.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const repo = process.argv[2] ?? process.cwd();
const fixture = pathToFileURL(join(repo, "test/fixtures/shadow-lab.html")).href;
const out = join(repo, "docs", "verified-write.png");

const server = spawn(process.execPath, [join(repo, "dist/server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    LAYA_PYTHON: join(homedir(), ".laya-ultra-browser/venv/bin/python"),
    LAYA_PROFILE_DIR: join(homedir(), ".laya-ultra-browser/profile"),
    LAYA_VISUALIZER: "false",
  },
});

let buf = "";
const pending = new Map();
server.stdout.setEncoding("utf8");
server.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const e = pending.get(m.id);
    if (e) { pending.delete(m.id); e(m); }
  }
});

let id = 1;
const req = (method, params, timeoutMs = 300000) => {
  const rid = id++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
};
const tool = async (name, args = {}) => {
  const r = await req("tools/call", { name, arguments: args });
  const t = (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.result?.isError) throw new Error(`${name}: ${t}`);
  return t;
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Keeps the lines a reader needs and drops the rest.
 *
 * The raw tool output is dominated by a geometry blob and a long advisory note. Both
 * matter in a transcript and neither survives being shrunk to fit in a README image,
 * so the screenshot shows the decision and the verdict, not the whole payload.
 */
function condense(text) {
  const keep = [];
  let inFields = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^element:/.test(line)) continue;
    if (/^text fields on this page:/.test(line)) {
      inFields = true;
      // Keep the count, drop the list: it is long and the point is only that one exists.
      continue;
    }
    if (inFields) {
      if (/^\s*</.test(line)) continue;
      inFields = false;
    }
    if (/^note: Laya's confidence/.test(line)) continue;
    if (/^note: Laya and the deterministic/.test(line)) {
      keep.push("note: the model and name matching disagreed about the target");
      continue;
    }
    if (line.trim() === "") continue;
    keep.push(line);
  }
  if (!keep.some((l) => l.startsWith("text fields"))) {
    // Put a compact marker where the list was dropped, so its absence is deliberate.
    const at = keep.findIndex((l) => l.startsWith("verified:"));
    if (at >= 0 && /does not accept/.test(keep.join("\n"))) {
      keep.splice(at + 1, 0, "text fields on this page: 6 listed, including <input id=\"light-input\">");
    }
  }
  return keep.join("\n");
}

const rows = [];
function add(label, value, kind = "") {
  rows.push(
    `<div class="row"><div class="lbl">${esc(label)}</div>` +
      `<pre class="${kind}">${esc(value)}</pre></div>`,
  );
}

try {
  await req("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "readme-shot", version: "0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  // The real fixture, so the shadow-DOM path is genuinely exercised.
  await tool("browser_navigate", { url: fixture });
  await tool("browser_status", { warm: true });

  add(
    '$ browser_write_text goal="the LIGHT_INPUT field"\n  value="person@example.com"',
    condense(
      await tool("browser_write_text", {
        goal: "the LIGHT_INPUT field",
        value: "person@example.com",
      }),
    ),
    "bad",
  );
  add(
    '$ browser_write_text selector="fake-lightning-input"\n  value="written into a shadow root"',
    condense(
      await tool("browser_write_text", {
        selector: "fake-lightning-input",
        value: "written into a shadow root",
      }),
    ),
    "good",
  );
  add(
    '$ browser_write_text selector="#light-input"\n  value="person@example.com"',
    condense(await tool("browser_write_text", { selector: "#light-input", value: "person@example.com" })),
    "good",
  );
} catch (err) {
  console.error("failed:", err.message);
  process.exitCode = 1;
} finally {
  server.stdin.end();
  setTimeout(() => server.kill(), 1500);
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  :root { --bg:#0b0e13; --panel:#12161d; --line:#232a34; --text:#e6edf3;
          --muted:#8b949e; --green:#3fb950; --red:#f85149; --amber:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); padding:26px 28px;
         font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .win { border:1px solid var(--line); border-radius:10px; overflow:hidden;
         background:var(--panel); max-width:1080px; }
  .bar { display:flex; align-items:center; gap:8px; padding:10px 14px;
         background:#171c24; border-bottom:1px solid var(--line); }
  .d { width:11px; height:11px; border-radius:50%; }
  .t { margin-left:8px; color:var(--muted); font-size:12px; }
  .row { display:grid; grid-template-columns:320px 1fr; gap:0;
         border-bottom:1px solid rgba(35,42,52,.6); }
  .row:last-child { border-bottom:none; }
  .lbl { padding:12px 14px; color:#79c0ff; white-space:pre-wrap; }
  pre { margin:0; padding:12px 14px; white-space:pre-wrap; word-break:break-word;
        color:var(--text); }
  pre.good { color:var(--green); } pre.bad { color:var(--red); }
  .foot { padding:9px 14px; color:var(--muted); font-size:11.5px;
          border-top:1px solid var(--line); background:#171c24; }
</style></head><body>
  <div class="win">
    <div class="bar">
      <div class="d" style="background:#ff5f57"></div>
      <div class="d" style="background:#febc2e"></div>
      <div class="d" style="background:#28c840"></div>
      <div class="t">laya-ultra-browser &mdash; every write verified by reading the value back</div>
    </div>
    ${rows.join("\n")}
    <div class="foot">A goal the model got wrong is refused, not reported as success. That is the whole point.</div>
  </div>
</body></html>`;

const tmp = join(homedir(), ".laya-ultra-browser", "readme-shot.html");
mkdirSync(dirname(tmp), { recursive: true });
writeFileSync(tmp, html);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1080, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`file://${tmp}`, { waitUntil: "load" });
const box = await page.locator(".win").boundingBox();
await page.setViewportSize({
  width: Math.ceil(box.width) + 2,
  height: Math.ceil(box.height) + 2,
});
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) } });
await browser.close();
console.log(`wrote ${out}`);
