/**
 * The missing-browser path, which is the one prerequisite failure a new user is most
 * likely to hit.
 *
 * Driven through the real MCP server rather than by importing the module, because the
 * actionable half of the error lives in `hint`, which only the tool layer appends to
 * `message`. Testing the module directly would pass while the user-facing text stayed
 * unhelpful, which is the whole point of the fix.
 *
 * The failure is produced by pointing the browser cache at an empty directory, so the
 * launch genuinely fails with a missing executable.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../support/paths.js";

const emptyCache = mkdtempSync(join(tmpdir(), "laya-no-browser-"));
const profile = mkdtempSync(join(tmpdir(), "laya-no-browser-profile-"));

after(() => {
  rmSync(emptyCache, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
});

/** Minimal MCP client: enough to call one tool and read the text back. */
class Client {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [repoPath("dist/server.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c: string) => {
      this.buffer += c;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry(msg);
        }
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    return {
      text: (r.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"),
      isError: r.result?.isError === true,
    };
  }

  async init(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "missing-browser-test", version: "0" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
    );
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      t.unref?.();
      this.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

describe("missing browser prerequisite", () => {
  let client: Client;
  let result: { text: string; isError: boolean };

  before(async () => {
    mkdirSync(emptyCache, { recursive: true });
    client = new Client({
      PLAYWRIGHT_BROWSERS_PATH: emptyCache,
      LAYA_PROFILE_DIR: profile,
      LAYA_VISUALIZER: "false",
      LAYA_LOG_LEVEL: "error",
    });
    await client.init();
    // browser_snapshot forces a launch without needing a real page.
    result = await client.call("browser_snapshot", {});
  });

  after(async () => {
    await client?.stop();
  });

  it("fails rather than pretending to work", () => {
    assert.equal(result.isError, true, "a missing browser must not report success");
  });

  it("does not leak Playwright's raw banner", () => {
    // The raw failure is a box-drawn banner with an install suggestion that does not
    // say where to run it. Not this project's error format, and not actionable.
    assert.doesNotMatch(result.text, /╔|╚|║/);
    assert.doesNotMatch(result.text, /<3 Playwright Team/);
  });

  it("says which prerequisite is missing", () => {
    assert.match(result.text, /Chromium/i);
    assert.match(result.text, /not installed/i);
  });

  it("gives a command, and says where to run it", () => {
    // Browsers are cached per Playwright version, so running the install in an
    // unrelated directory installs the wrong revision and the error does not go away.
    // Saying "run this in the package directory" is the part that makes it actionable.
    assert.match(result.text, /npx playwright install chromium/);
    assert.match(result.text, /package directory|not an unrelated one/i);
  });

  it("offers the escape hatch for someone who already has Chrome", () => {
    assert.match(result.text, /LAYA_CHROME_PATH/);
  });

  it("leaves the server alive so the next call can succeed", async () => {
    // A prerequisite failure must not poison the process.
    const status = await client.call("browser_status", {});
    assert.equal(status.isError, false);
    assert.match(status.text, /"running": false/);
  });
});

describe("browser present", () => {
  it("launches when the cache is real", async () => {
    // The control for the test above: the same code against a real cache must work,
    // which is what proves the failure was the cache and not something else.
    const client = new Client({
      LAYA_PROFILE_DIR: profile,
      LAYA_VISUALIZER: "false",
      LAYA_LOG_LEVEL: "error",
    });
    try {
      await client.init();
      const status = await client.call("browser_status", {});
      assert.equal(status.isError, false);
      const snap = await client.call("browser_navigate", { url: "about:blank" });
      assert.equal(snap.isError, false, snap.text);
    } finally {
      await client.stop();
    }
  });
});
