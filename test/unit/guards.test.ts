/**
 * The process must survive a stray rejection and exit on a real exception.
 *
 * Provoked in a child process rather than asserted by reading the source, because the
 * whole point is what the runtime does, and the default is to crash.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { repoPath } from "../support/paths.js";

const guards = repoPath("dist/guards.js");

/**
 * Installs the guards, provokes `mode`, then reports what the process did.
 * Writes a sentinel to stdout so a crash is distinguishable from a hang.
 */
function provoke(mode: "rejection" | "exception"): { code: number; stderr: string; stdout: string } {
  const script = `
    const { installProcessGuards } = await import(${JSON.stringify(guards)});
    installProcessGuards();
    ${
      mode === "rejection"
        ? // A promise nobody is waiting on, which is what a detached failure looks like.
          'Promise.reject(new Error("stray rejection from a detached promise"));'
        : 'setTimeout(() => { throw new Error("thrown from a timer"); }, 10);'
    }
    // If the process survives, prove it is still able to do work and then say so.
    setTimeout(() => { process.stdout.write("STILL_ALIVE"); process.exit(0); }, 400);
  `;
  // spawnSync rather than execFileSync: the success path needs stderr too, since the
  // point of the rejection case is that the process lives and says what happened.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    code: r.status ?? -1,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? "",
  };
}

describe("process guards", () => {
  it("survives an unhandled rejection and says so", () => {
    const r = provoke("rejection");
    assert.match(
      r.stdout,
      /STILL_ALIVE/,
      `the process died on a stray rejection (exit ${r.code})\n${r.stderr}`,
    );
    assert.match(r.stderr, /unhandled promise rejection/);
    assert.match(r.stderr, /stray rejection from a detached promise/);
  });

  it("exits on an uncaught exception, because process state is unknown", () => {
    // Continuing after an uncaught exception is how a browser agent ends up clicking
    // things with a half-torn-down state. Exiting loudly is the safer failure.
    const r = provoke("exception");
    assert.notEqual(r.code, 0, "an uncaught exception must not be swallowed");
    assert.doesNotMatch(r.stdout, /STILL_ALIVE/, "the process kept running after an uncaught exception");
    assert.match(r.stderr, /uncaught exception/);
    assert.match(r.stderr, /thrown from a timer/);
  });

  it("does not log the stack twice for one exception", () => {
    // Node prints the uncaught exception itself; logging it again would double every
    // line in the client's server log.
    const r = provoke("exception");
    const occurrences = (r.stderr.match(/thrown from a timer/g) ?? []).length;
    assert.ok(occurrences <= 2, `the same error appeared ${occurrences} times`);
  });
});
