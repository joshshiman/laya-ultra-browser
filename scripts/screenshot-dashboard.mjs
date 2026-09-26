/**
 * Capture the dashboard with real ranking data in it, for the README.
 *
 * Runs the actual server against the conformance fixture with the visualizer on and
 * Laya enabled, then screenshots the dashboard. Skips cleanly if the model runtime is
 * not installed, since a screenshot of an empty dashboard would be misleading.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = process.argv[2] ?? process.cwd();
const out = join(root, "docs", "dashboard.png");
const fixture = pathToFileURL(join(root, "test/fixtures/shadow-lab.html")).href;

const server = spawn(process.execPath, [join(root, "dist/server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    LAYA_PYTHON: join(homedir(), ".laya-ultra-browser/venv/bin/python"),
    LAYA_PROFILE_DIR: join(homedir(), ".laya-ultra-browser/profile"),
    LAYA_VISUALIZER: "true",
    LAYA_VISUALIZER_PORT: "7317",
  },
});

let buf = "";
const pending = new Map();
let stderr = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stderr.on("data", (c) => (stderr += c));
server.stdout.on("data", (chunk) => {
  buf += chunk;
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

try {
  await req("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "screenshot", version: "0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const status = JSON.parse(await tool("browser_status", { warm: true }));
  if (!status.laya.available) {
    console.error("Laya is not available; refusing to write a screenshot of an empty dashboard.");
    console.error(status.laya.hint);
    process.exit(2);
  }

  await tool("browser_navigate", { url: fixture });

  // A few calls so the feed has more than one card in it.
  await tool("browser_write_text", { goal: "the LIGHT_INPUT field", value: "screenshot demo" });
  await tool("browser_write_text", { selector: "fake-lightning-input", value: "verified write" });
  await tool("browser_write_text", { selector: "#light-button", value: "not a field" });
  await tool("browser_find", { goal: "the search field", limit: 6 });

  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:7317/", { waitUntil: "networkidle" });
  // Let the bar transitions finish before capturing.
  await page.waitForTimeout(1400);
  mkdirSync(join(root, "docs"), { recursive: true });
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  console.log(`wrote ${out}`);
} catch (err) {
  console.error("failed:", err.message);
  console.error(stderr.split("\n").slice(-20).join("\n"));
  process.exitCode = 1;
} finally {
  server.stdin.end();
  setTimeout(() => server.kill(), 2000);
}
