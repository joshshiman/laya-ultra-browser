/**
 * Strips comments from src/snapshot/walker.js so it can be injected through an
 * eval-style tool without burning tokens on documentation. Not a minifier: it
 * preserves newlines, because collapsing to one line would let a trailing //
 * comment swallow the rest of the file.
 *
 * Safe for this file specifically because it contains no `//` inside any string
 * or regex literal. The check below enforces that assumption.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src/snapshot/walker.js");
const OUT = resolve(here, "out/walker.min.js");

const original = readFileSync(SRC, "utf8");

// Guard: if a string literal ever contains //, the line-comment strip below
// would corrupt it. Fail loudly rather than emit a broken build.
if (/"[^"\n]*\/\/|'[^'\n]*\/\//.test(original)) {
  console.error("build-walker: found // inside a string literal. Strip manually.");
  process.exit(1);
}

const stripped = original
  .replace(/\/\*\*[\s\S]*?\*\//g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1").trimEnd().trim())
  .filter((line) => line.length > 0)
  .join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, stripped);

// Both files must parse. A syntax error here means the strip broke something.
for (const file of [SRC, OUT]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

const pct = Math.round((1 - stripped.length / original.length) * 100);
console.log(`build-walker: ${original.length} -> ${stripped.length} bytes (-${pct}%), both parse OK`);
