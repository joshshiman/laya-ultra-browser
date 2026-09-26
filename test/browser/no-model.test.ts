/**
 * The server must be fully usable by someone who never ran the Laya setup.
 *
 * This is a real path, not a degraded one: the ranker is an accelerator, and a user on
 * Linux, on Intel, or who simply skipped `npm run setup:laya` should get a working
 * browser server with a clear explanation of what is missing and what they lose.
 *
 * Driven against a real server with LAYA_PYTHON pointed at an interpreter that cannot
 * import the runtime, which is the honest simulation of that situation.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../support/paths.js";

const fixtureUrl = pathToFileURL(repoPath("test/fixtures/shadow-lab.html")).href;
const profile = mkdtempSync(join(tmpdir(), "laya-no-model-"));

after(() => rmSync(profile, { recursive: true, force: true }));

class Client {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  stderr = "";

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [repoPath("dist/server.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => (this.stderr += c));
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

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
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
      clientInfo: { name: "no-model-test", version: "0" },
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

describe("without the local model", () => {
  let client: Client;

  before(async () => {
    // An interpreter that definitely cannot import the runtime: a directory.
    client = new Client({
      LAYA_PYTHON: profile,
      LAYA_PROFILE_DIR: profile,
      LAYA_VISUALIZER: "false",
    });
    await client.init();
  });

  after(async () => {
    await client?.stop();
  });

  it("starts and reports the ranker as unavailable", async () => {
    const status = await client.call("browser_status");
    assert.equal(status.isError, false, status.text);
    const parsed = JSON.parse(status.text);
    assert.equal(parsed.laya.available, false);
  });

  it("says what is missing and what to do, rather than failing quietly", async () => {
    const status = JSON.parse((await client.call("browser_status")).text);
    assert.ok(status.laya.reason.length > 0, "an unavailable ranker needs a reason");
    assert.match(status.laya.hint, /setup:laya|npm run setup:laya/);
    assert.ok(Array.isArray(status.laya.tried), "it should list the interpreters it tried");
  });

  it("still navigates and snapshots", async () => {
    const nav = await client.call("browser_navigate", { url: fixtureUrl });
    assert.equal(nav.isError, false, nav.text);
    const snap = await client.call("browser_snapshot", {});
    assert.equal(snap.isError, false, snap.text);
    assert.match(snap.text, /LIGHT_INPUT/);
  });

  it("still writes, and still verifies", async () => {
    // The whole point of the deterministic layer is that it needs no model.
    const write = await client.call("browser_write_text", {
      selector: "#light-input",
      value: "no model needed",
    });
    assert.equal(write.isError, false, write.text);
    assert.match(write.text, /verified: yes/, write.text);

    const read = JSON.parse((await client.call("browser_read_value", { selector: "#light-input" })).text);
    assert.equal(read.value, "no model needed");
  });

  it("still writes into a shadow root and verifies", async () => {
    const write = await client.call("browser_write_text", {
      selector: "fake-lightning-input",
      value: "still works",
    });
    assert.match(write.text, /verified: yes/, write.text);
    assert.match(write.text, /descended into/, write.text);
  });

  it("resolves a goal deterministically and says which path it used", async () => {
    // A goal with no model must still work, and must not claim a model ranked it.
    const write = await client.call("browser_write_text", {
      goal: "the LIGHT_INPUT field",
      value: "deterministic goal",
    });
    assert.equal(write.isError, false, write.text);
    assert.match(write.text, /verified: yes/, write.text);
    assert.match(write.text, /deterministic/, write.text);
  });

  it("does not mention the unavailable model as a failure of the action", async () => {
    const write = await client.call("browser_write_text", { selector: "#light-input", value: "quiet" });
    assert.doesNotMatch(
      write.text,
      /laya_mlx|unavailable/i,
      "a successful write should not be annotated with model trouble",
    );
  });

  it("survives the whole sequence", async () => {
    assert.match(client.stderr, /ready on stdio/, "the server should have started normally");
  });
});
