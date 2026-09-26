/**
 * Locates the repository root from compiled test code.
 *
 * Tests run from dist-test/, not from test/, so a relative "../../.." lands in the
 * wrong place. Walking up to the directory that holds both package.json and tsconfig.json
 * is the only reliable anchor, and it works whether the tests run from source or from
 * the compiled output.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findUp(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "tsconfig.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repository root from ${from}`);
}

export const repoRoot = findUp(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to a file in the repository. */
export function repoPath(...parts: string[]): string {
  return resolve(repoRoot, ...parts);
}
