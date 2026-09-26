/**
 * Audits that every LAYA_* environment variable is actually read somewhere.
 *
 * A documented setting that nothing reads is worse than no setting: the README becomes
 * a lie and the user debugs the wrong thing. This walks the config module, derives the
 * property name each variable feeds, and checks some other module consumes it.
 *
 * Run: node scripts/audit-config.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const configSrc = readFileSync(join(root, "src/config.ts"), "utf8");
const envs = [...new Set([...configSrc.matchAll(/"(LAYA_[A-Z_]+)"/g)].map((m) => m[1]))];
const sources = walk(join(root, "src")).filter((f) => !f.endsWith("config.ts"));

const readme = readFileSync(join(root, "README.md"), "utf8");
const docs = readdirSync(join(root, "docs"))
  .map((f) => readFileSync(join(root, "docs", f), "utf8"))
  .join("\n");

/** LAYA_MAX_OPTIONS -> maxOptions, LAYA_INCLUDE_HIDDEN -> includeHidden */
function toCamel(env) {
  return env
    .replace(/^LAYA_/, "")
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * A few variables feed a property whose name is not a mechanical transform of the
 * variable. Listing them keeps the audit honest: without this the script reports a
 * working setting as dead, and an audit that cries wolf gets ignored.
 */
const ALIASES = {
  LAYA_CHROME_PATH: ["executablePath"],
  LAYA_VISUALIZER_HOST: ["visualizer\\.host", "\\bhost\\b"],
  LAYA_VISUALIZER_PORT: ["visualizer\\.port", "\\bport\\b"],
  LAYA_VISUALIZER_HISTORY: ["visualizer\\.history", "\\bhistory\\b"],
};

let dead = 0;
let undocumented = 0;
const rows = [];

for (const env of envs) {
  const names = ALIASES[env] ?? [toCamel(env)];
  // The config object nests `laya` and `visualizer`; accept any path ending in the key.
  const patterns = names.map((n) => new RegExp(`config(\\.[a-zA-Z]+)*\\.${n}\\b`));
  const where = sources
    .filter((f) => {
      const body = readFileSync(f, "utf8");
      return patterns.some((re) => re.test(body));
    })
    .map((f) => f.split("/").pop());
  const documented = readme.includes(env) || docs.includes(env);
  if (where.length === 0) dead++;
  if (!documented) undocumented++;
  rows.push({
    env,
    status: where.length ? "used" : "DEAD",
    where: where.join(", ") || "-",
    docs: documented ? "yes" : "NO",
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("ENV", 28) + pad("STATUS", 8) + pad("DOCS", 6) + "READ BY");
for (const r of rows) {
  console.log(pad(r.env, 28) + pad(r.status, 8) + pad(r.docs, 6) + r.where);
}
console.log(`\n${envs.length} variables, ${dead} dead, ${undocumented} undocumented`);
process.exit(dead === 0 && undocumented === 0 ? 0 : 1);
