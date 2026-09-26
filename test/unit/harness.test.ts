/**
 * Guards against the failure mode this repo shipped with: a test command that exits 0
 * while running nothing, so `npm run check` was green on a repo whose build was broken.
 *
 * These assertions are about the harness rather than the code, and they are the reason
 * a future contributor finds out immediately if a test stops being discovered.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath, repoRoot } from "../support/paths.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("test harness integrity", () => {
  it("finds at least one test file", () => {
    const files = walk(join(repoRoot, "test")).filter((f) => f.endsWith(".test.ts"));
    assert.ok(files.length > 0, "no .test.ts files found under test/");
  });

  it("runs tests from both the unit and browser suites", () => {
    // Guards the original defect directly: `node --test test/` matched no files and
    // still exited 0.
    for (const suite of ["unit", "browser"]) {
      const dir = join(repoRoot, "test", suite);
      const files = walk(dir).filter((f) => f.endsWith(".test.ts"));
      assert.ok(files.length > 0, `test/${suite} contains no test files`);
    }
  });

  it("the test script builds the injection bundles the fixture loads", () => {
    const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
    // The fixture loads scripts/out/*.min.js, which is gitignored, so it does not
    // exist on a fresh clone. Either the test script or its pretest hook has to
    // regenerate it, or `npm test` fails on a clean checkout.
    const chain = `${pkg.scripts.pretest ?? ""} ${pkg.scripts.test ?? ""}`;
    assert.match(
      chain,
      /build:inject/,
      "no test step runs build:inject, so the fixture's scripts/out/*.min.js will be " +
        "missing on a fresh clone and the browser tests will fail to load the in-page layer",
    );
  });

  it("the typecheck target has real inputs", () => {
    // tsconfig only includes src/**/*.ts. If every source file were .js, tsc would
    // exit non-zero with TS18003, which is exactly the broken state this repo shipped.
    const tsconfig = JSON.parse(
      readFileSync(repoPath("tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    );
    const include = tsconfig.include ?? [];
    assert.ok(include.length > 0, "tsconfig has no include patterns");
    const sources = walk(repoPath("src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    assert.ok(sources.length > 0, "no TypeScript sources found, so tsc would fail with TS18003");
  });

  it("every source file referenced by the build exists", () => {
    const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
    for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
      const src = repoPath(target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
      assert.ok(
        existsSyncSafe(src),
        `bin "${name}" points at ${target}, but ${src} does not exist`,
      );
    }
  });

  it("declares a license file that matches package.json", () => {
    const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
    assert.equal(pkg.license, "MIT");
    assert.ok(
      existsSyncSafe(repoPath("LICENSE")),
      "package.json declares MIT but there is no LICENSE file",
    );
  });

  it("runs a typecheck that passes", () => {
    // The slowest guard, and the one that would have caught the original state.
    try {
      execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      assert.fail(`typecheck failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
  });

  it("typechecks the test sources too", () => {
    // A test suite that does not compile is worse than no test suite, because the
    // failure mode is a confusing module-not-found at run time.
    try {
      execFileSync("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      assert.fail(`test typecheck failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
