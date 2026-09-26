/**
 * The shipped artifact, driven over the real MCP protocol.
 *
 * Everything else in this suite imports modules directly. This spawns dist/server.js
 * as a child process and speaks newline-delimited JSON-RPC to it on stdio, which is
 * exactly what an MCP client does. It is the only test that would catch a broken
 * shebang, a stdout write that corrupts the transport, a tool that is registered but
 * not reachable, or a server that starts and then dies.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoPath } from "../support/paths.js";

const fixtureUrl = pathToFileURL(repoPath("test/fixtures/shadow-lab.html")).href;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly stderr: string[] = [];

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      // Keep a bounded tail: useful in a failure message, harmless otherwise.
      this.stderr.push(...chunk.split("\n").filter(Boolean));
      if (this.stderr.length > 400) this.stderr.splice(0, this.stderr.length - 400);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout means something wrote to the transport by mistake.
        // Fail loudly: that is precisely the bug this test exists to catch.
        throw new Error(`server wrote a non-JSON line to stdout: ${line.slice(0, 300)}`);
      }
      const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!entry) continue;
      this.pending.delete(msg.id);
      entry.resolve(msg);
    }
  }

  request(method: string, params: unknown, timeoutMs = 240_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out after ${timeoutMs}ms\nstderr:\n${this.stderr.slice(-25).join("\n")}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (res.error) {
      throw new Error(`tool ${name} returned a protocol error: ${JSON.stringify(res.error)}`);
    }
    const content = res.result?.content ?? [];
    return content.map((c: any) => c.text ?? "").join("\n");
  }

  async initialize(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "laya-ultra-browser-test", version: "0.0.0" },
    });
    assert.ok(res.result?.serverInfo?.name, "initialize should identify the server");
    this.notify("notifications/initialized", {});
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 8_000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

describe("mcp server over stdio", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient(process.execPath, [repoPath("dist/server.js")], {
      // Keep the suite off any developer profile and out of the developer's home.
      LAYA_PROFILE_DIR: repoPath(".test-profile"),
      LAYA_VISUALIZER: "false",
    });
    await client.initialize();
  });

  after(async () => {
    await client?.stop();
  });

  it("identifies itself", async () => {
    const res = await client.request("tools/list", {});
    const tools = res.result?.tools ?? [];
    assert.ok(Array.isArray(tools) && tools.length > 0, "expected at least one tool");
    const names = tools.map((t: any) => t.name).sort();
    for (const expected of [
      "browser_click",
      "browser_find",
      "browser_inspect",
      "browser_navigate",
      "browser_read_value",
      "browser_select_option",
      "browser_snapshot",
      "browser_status",
      "browser_write_text",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}; got ${names.join(", ")}`);
    }
  });

  it("gives every tool a description and an input schema", async () => {
    // A tool with no description is unusable by an agent, and one with no schema cannot
    // be called. Cheap to assert, and it is the difference between a working MCP server
    // and one that technically starts.
    const res = await client.request("tools/list", {});
    for (const tool of res.result?.tools ?? []) {
      assert.ok(
        typeof tool.description === "string" && tool.description.length > 20,
        `tool ${tool.name} has no usable description`,
      );
      assert.equal(tool.inputSchema?.type, "object", `tool ${tool.name} has no object schema`);
    }
  });

  it("reports status before the browser is started", async () => {
    const text = await client.callTool("browser_status", {}, 60_000);
    const status = JSON.parse(text);
    assert.equal(status.browser.running, false);
    assert.equal(typeof status.laya.available, "boolean");
    // Whichever way Laya resolved, the report has to say something actionable.
    if (!status.laya.available) {
      assert.ok(status.laya.hint && status.laya.hint.length > 0, "unavailable Laya needs a hint");
    }
  });

  it("starts the visualizer only when asked", async () => {
    const text = await client.callTool("browser_status", {}, 60_000);
    const status = JSON.parse(text);
    assert.equal(status.visualizer.enabled, false);
    assert.equal(status.visualizer.running, false);
  });

  it("navigates and snapshots the fixture", async () => {
    const nav = JSON.parse(await client.callTool("browser_navigate", { url: fixtureUrl }));
    assert.equal(nav.ok, true);
    assert.match(nav.url, /shadow-lab\.html$/);

    const snap = await client.callTool("browser_snapshot", { includeOffscreen: false });
    assert.match(snap, /LIGHT_BUTTON/, "the light DOM button should be listed");
    assert.match(snap, /control\(s\)/);
  });

  it("writes to a shadow-DOM field and verifies it", async () => {
    // The whole point of the project. The field lives inside a closed-ish component
    // wrapper, so a naive document-level write would report success and change nothing.
    const text = await client.callTool("browser_write_text", {
      selector: "fake-lightning-input",
      value: "written over mcp",
    });
    assert.match(text, /write_text: ok/, text);
    assert.match(text, /verified: yes/, text);
    assert.doesNotMatch(text, /verified: NO/, text);

    const read = JSON.parse(
      await client.callTool("browser_read_value", { selector: "fake-lightning-input" }),
    );
    assert.equal(read.value, "written over mcp");
  });

  it("reports an unverified write as a failure rather than a success", async () => {
    // Forcing noDescend writes to the wrapper, which echoes the value while the real
    // inner control never takes it. The honest answer is verified:false.
    const text = await client.callTool("browser_write_text", {
      selector: "fake-lightning-input",
      value: "echo test",
      noDescend: true,
    });
    assert.match(text, /FAILED/, text);
    assert.match(text, /verified: NO/, text);
    assert.match(text, /hostEchoedValue/, text);
  });

  it("resolves a natural-language goal without a model", async () => {
    // Deterministic path, so this works even where Laya is absent.
    const text = await client.callTool("browser_write_text", {
      goal: "the LIGHT_INPUT field",
      value: "goal write",
      deterministic: true,
    });
    assert.match(text, /verified: yes/, text);
    assert.match(text, /deterministic/, text);
  });

  it("ranks candidates with browser_find", async () => {
    const text = await client.callTool(
      "browser_find",
      { goal: "the LIGHT_INPUT field", deterministic: true, limit: 5 },
      60_000,
    );
    assert.match(text, /selected/, text);
    assert.match(text, /ref=/, text);
  });

  it("explains a missing target instead of failing silently", async () => {
    const text = await client.callTool("browser_write_text", {
      selector: "#no-such-element-anywhere",
      value: "x",
    });
    assert.match(text, /FAILED/, text);
    assert.match(text, /resolve/, text);
  });

  it("refuses a disabled field before attempting the write", async () => {
    const text = await client.callTool("browser_write_text", {
      selector: "#disabled-input",
      value: "x",
    });
    assert.match(text, /FAILED/, text);
    assert.match(text, /disabled/i, text);
  });

  it("survives a call with no target at all", async () => {
    // A bad call must produce a readable error, not kill the server.
    const text = await client.callTool("browser_write_text", { value: "x" });
    assert.match(text, /Error|No target/i, text);
    assert.ok(client.alive, "the server must survive a malformed call");
  });

  it("answers an unknown tool name instead of going silent", async () => {
    // An unanswered tools/call hangs the client forever, which is far worse than an
    // error. The SDK surfaces this as an isError result rather than a JSON-RPC error,
    // so accept either shape and insist only that the caller gets told.
    const res = await client.request("tools/call", {
      name: "browser_does_not_exist",
      arguments: {},
    });
    const flagged = Boolean(res.error) || res.result?.isError === true;
    assert.ok(flagged, `expected an error response, got ${JSON.stringify(res)}`);
    const text = (res.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
    const message = res.error ? JSON.stringify(res.error) : text;
    assert.match(message, /not found/i, "the error should name the problem");
    assert.ok(client.alive, "the server must survive an unknown tool");
  });

  it("exits cleanly when stdin closes", async () => {
    // An orphaned Chromium is the classic MCP server bug. The parent closing the pipe
    // has to take the browser and the Laya bridge down with it.
    const solo = new McpClient(process.execPath, [repoPath("dist/server.js")], {
      LAYA_PROFILE_DIR: repoPath(".test-profile-2"),
    });
    await solo.initialize();
    await solo.callTool("browser_navigate", { url: fixtureUrl });
    await solo.stop();
    assert.ok(!solo.alive, "the server should have exited when stdin closed");
  });
});
