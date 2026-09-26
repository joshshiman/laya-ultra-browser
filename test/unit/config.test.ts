/**
 * Config parsing.
 *
 * Config is read from the environment at import time, which makes it awkward to test
 * in-process. These tests exercise the validation rules through a child process so each
 * case gets a clean module registry, and so a bad value is proven to fail loudly at
 * startup rather than being silently coerced.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repoPath } from "../support/paths.js";

const configModule = repoPath("src", "config.ts");

/** Imports config.ts in a child process with the given env, returning stdout or the error. */
function loadConfig(env: Record<string, string>): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(configModule)}).then(m => {
           const c = m.config;
           console.log(JSON.stringify({
             callTimeoutMs: c.callTimeoutMs,
             headed: c.headed,
             maxOptions: c.laya.maxOptions,
             mode: c.laya.mode,
             idleTimeoutMs: c.idleTimeoutMs,
           }));
         }).catch(e => { console.error(e.message); process.exit(1); });`,      ],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, out: e.stderr ?? String(err) };
  }
}

describe("config", () => {
  it("uses documented defaults when nothing is set", () => {
    const r = loadConfig({});
    assert.equal(r.ok, true, r.out);
    const cfg = JSON.parse(r.out);
    assert.equal(cfg.callTimeoutMs, 30_000);
    assert.equal(cfg.headed, false);
    assert.equal(cfg.maxOptions, 12);
    assert.equal(cfg.mode, "choice");
  });

  it("accepts overrides", () => {
    const r = loadConfig({
      LAYA_CALL_TIMEOUT_MS: "5000",
      LAYA_HEADED: "true",
      LAYA_MAX_OPTIONS: "8",
      LAYA_MODE: "noul",
    });
    assert.equal(r.ok, true, r.out);
    const cfg = JSON.parse(r.out);
    assert.equal(cfg.callTimeoutMs, 5000);
    assert.equal(cfg.headed, true);
    assert.equal(cfg.maxOptions, 8);
    assert.equal(cfg.mode, "noul");
  });

  it("rejects a non-numeric value instead of coercing it", () => {
    const r = loadConfig({ LAYA_CALL_TIMEOUT_MS: "soon" });
    assert.equal(r.ok, false);
    assert.match(r.out, /must be a number/);
  });

  it("rejects a value outside its range", () => {
    // The option ceiling is a hard limit of the model's head, so an out-of-range value
    // has to fail at startup rather than become a confusing runtime error.
    const r = loadConfig({ LAYA_MAX_OPTIONS: "500" });
    assert.equal(r.ok, false);
    assert.match(r.out, /must be between/);
  });

  it("rejects an unknown ranking mode", () => {
    const r = loadConfig({ LAYA_MODE: "psychic" });
    assert.equal(r.ok, false);
    assert.match(r.out, /choice.*noul|noul.*choice/s);
  });

  it("rejects a non-boolean flag", () => {
    const r = loadConfig({ LAYA_HEADED: "maybe" });
    assert.equal(r.ok, false);
    assert.match(r.out, /must be a boolean/);
  });

  it("treats an empty value as unset rather than as an error", () => {
    // MCP clients routinely pass through empty strings for unset variables.
    const r = loadConfig({ LAYA_CALL_TIMEOUT_MS: "" });
    assert.equal(r.ok, true, r.out);
    assert.equal(JSON.parse(r.out).callTimeoutMs, 30_000);
  });
});
