/**
 * Copies non-TypeScript runtime assets into dist/ after tsc runs.
 *
 * Two kinds of asset need this:
 *
 *   1. src/snapshot/*.js -- the proven in-page layer. tsc ignores it (it is plain
 *      JS, deliberately, so it can be injected verbatim), but the server needs the
 *      source text at runtime to inject it. Reads as dist/snapshot/*.js.
 *
 *   2. src/laya/bridge.py -- the Python side of the Laya ranker. Copied verbatim
 *      and located at runtime relative to the compiled module.
 *
 * Only these extensions are copied. Without the filter, the .ts sources sitting
 * alongside them get copied too and ship a second, stale copy of the code.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");

const WANTED = new Set([".js", ".py", ".html"]);

function copyAssets(from, to) {
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      n += copyAssets(src, dst);
    } else if (WANTED.has(extname(entry.name))) {
      copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

let total = 0;
total += copyAssets(join(root, "src", "snapshot"), join(dist, "snapshot"));
total += copyAssets(join(root, "src", "laya"), join(dist, "laya"));

console.log(`copy-assets: ${total} file(s) into dist/`);

