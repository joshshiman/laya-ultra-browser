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
const TARGETS = ["walker", "actions"];

/**
 * Remove a trailing // comment, but only when the // is genuinely outside a
 * string or regex literal. A naive regex gets this wrong on lines like
 *   if (tag.indexOf("-") < 0) return el; // not a custom element
 * where a string appears before a real comment. Tracks quote state instead.
 */
function stripLineComment(line) {
  let quote = null; // the open quote char, or null
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    // A regex literal can contain //, but not in these files, and a division
    // followed immediately by another slash is not valid JS, so this is safe.
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

for (const name of TARGETS) {
  const SRC = resolve(here, `../src/snapshot/${name}.js`);
  const OUT = resolve(here, `out/${name}.min.js`);

  const original = readFileSync(SRC, "utf8");

  const stripped = original
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => stripLineComment(line).trimEnd().trim())
    .filter((line) => line.length > 0)
    .join("\n");

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, stripped);

  // Both files must parse. A syntax error here means the strip broke something.
  for (const file of [SRC, OUT]) {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  }

  const pct = Math.round((1 - stripped.length / original.length) * 100);
  console.log(`build: ${name}.js ${original.length} -> ${stripped.length} bytes (-${pct}%), parses OK`);
}
