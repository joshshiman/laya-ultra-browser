/**
 * Guards against the class of defect where a documented setting does nothing.
 *
 * This repo shipped with two LAYA_* variables that were defined, documented in the
 * README, and read by nothing. A user setting LAYA_INCLUDE_HIDDEN=true would have seen
 * no change and had no way to learn why.
 *
 * The audit itself lives in scripts/audit-config.mjs so it can be run on its own and
 * from `npm run check`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoPath } from "../support/paths.js";

/** Every LAYA_* name declared in the config module. */
function declaredEnvVars(): string[] {
  const configSrc = readFileSync(repoPath("src/config.ts"), "utf8");
  return [...new Set([...configSrc.matchAll(/"(LAYA_[A-Z_]+)"/g)].map((m) => m[1]!))];
}

describe("environment variables", () => {
  it("declares a non-trivial number of them", () => {
    // A guard on the guard: if the regex ever stops matching, the tests below would
    // pass vacuously.
    assert.ok(declaredEnvVars().length >= 15, "expected the config module to declare many variables");
  });

  it("reads every declared variable somewhere", () => {
    try {
      const out = execFileSync(process.execPath, [repoPath("scripts/audit-config.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(out, /0 dead/, out);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      assert.fail(
        `config audit failed. A documented variable that nothing reads is worse than no ` +
          `variable, because the user debugs the wrong thing.\n${e.stdout ?? ""}${e.stderr ?? ""}`,
      );
    }
  });

  it("documents every declared variable in the README", () => {
    const readme = readFileSync(repoPath("README.md"), "utf8");
    for (const env of declaredEnvVars()) {
      assert.ok(readme.includes(env), `${env} is not in the README configuration table`);
    }
  });

  it("is wired into check so it cannot rot", () => {
    const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
    assert.match(pkg.scripts["audit:config"] ?? "", /audit-config/);
    assert.match(pkg.scripts.check, /audit:config/);
  });
});
