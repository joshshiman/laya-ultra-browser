/**
 * Central configuration. Every knob is an environment variable with a documented
 * default, resolved once at startup so a malformed value fails immediately with a
 * clear message rather than surfacing as a confusing error mid-task.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Throws with an actionable message rather than silently using a bad value. */
function num(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be a boolean (true/false), got ${JSON.stringify(raw)}`);
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Locates the package root by walking up from this module until a package.json turns
 * up, then anchors runtime assets on <root>/dist.
 *
 * Anchoring on import.meta.url directly would be simpler but breaks as soon as the
 * compiled code is not sitting in dist/: the test build emits to dist-test/src, and a
 * globally installed copy lives under a node_modules path. Resolving the root means
 * asset lookup behaves identically in all three cases.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const packageRoot = findPackageRoot(dirnameOf(import.meta.url));

/** Directory the runtime assets live in, independent of where this module was compiled. */
export const distDir = join(packageRoot, "dist");

function dirnameOf(url: string): string {
  return resolve(fileURLToPath(url), "..");
}

export const config = {
  /** Run Chromium with a visible window. Needed for any manual login step. */
  headed: bool("LAYA_HEADED", false),

  /** Per-call ceiling for any single tool invocation, in ms. */
  callTimeoutMs: num("LAYA_CALL_TIMEOUT_MS", 30_000, 1_000, 600_000),

  /** Ceiling for page navigation to reach load, in ms. */
  navigationTimeoutMs: num("LAYA_NAVIGATION_TIMEOUT_MS", 30_000, 1_000, 600_000),

  /** Shut the browser down after this long with no tool calls. 0 disables. */
  idleTimeoutMs: num("LAYA_IDLE_TIMEOUT_MS", 900_000, 0, 86_400_000),

  /** Hard cap on elements pulled from a snapshot. */
  maxSnapshotElements: num("LAYA_MAX_SNAPSHOT_ELEMENTS", 400, 1, 5_000),

  /** Include offscreen and covered controls in snapshots. Off by default. */
  includeHidden: bool("LAYA_INCLUDE_HIDDEN", false),

  /** Persist the browser profile between runs so a login survives a restart. */
  persistentProfile: bool("LAYA_PERSISTENT_PROFILE", true),
  profileDir: str("LAYA_PROFILE_DIR", join(homedir(), ".laya-ultra-browser", "profile")),

  /** Chromium executable override, for a system Chrome instead of the bundled one. */
  executablePath: str("LAYA_CHROME_PATH", ""),

  laya: {    /**
     * Python interpreter to use for the Laya bridge. Resolution order:
     *   1. LAYA_PYTHON
     *   2. the uv-managed env this repo's setup script creates
     *   3. python3 on PATH
     * Laya is optional: if none of these can import laya_mlx, every tool still
     * works and only the Laya-ranked path reports itself unavailable.
     */
    python: str(
      "LAYA_PYTHON",
      join(homedir(), ".laya-ultra-browser", "venv", "bin", "python"),
    ),
    /** Also try these interpreters if the primary one cannot import laya_mlx. */
    fallbackPythons: ["python3", "python"],

    /** Checkpoint id, optionally with a subfolder after a slash. */
    model: str("LAYA_MODEL", "convaiinnovations/laya"),
    checkpoint: str("LAYA_CHECKPOINT", ""),

    /** Seconds to wait for the bridge to import the model and answer a ping. */
    startupTimeoutMs: num("LAYA_STARTUP_TIMEOUT_MS", 180_000, 1_000, 1_800_000),

    /** Per-call ceiling for a ranking request once the bridge is warm. */
    requestTimeoutMs: num("LAYA_REQUEST_TIMEOUT_MS", 30_000, 1_000, 600_000),

    /**
     * Laya's option head shares a fixed token budget, so a `choice` question
     * degrades badly past roughly 20 options and laya-mlx raises past its budget.
     * Candidates are pre-ranked down to this many before the model sees them.
     */
    maxOptions: num("LAYA_MAX_OPTIONS", 12, 2, 20),

    /** Candidates handed to the model per ranking call. */
    maxCandidates: num("LAYA_MAX_CANDIDATES", 60, 1, 400),

    /**
     * Rank with per-candidate `noul` questions instead of one `choice`.
     * Slower (one forward pass per candidate) but sidesteps the option ceiling.
     */
    mode: (() => {
      const v = str("LAYA_MODE", "choice").toLowerCase();
      if (v !== "choice" && v !== "noul") {
        throw new Error(`LAYA_MODE must be "choice" or "noul", got ${JSON.stringify(v)}`);
      }
      return v as "choice" | "noul";
    })(),

    /** Set false to keep the bridge from ever starting. */
    enabled: bool("LAYA_ENABLED", true),
  },

  visualizer: {
    /**
     * Off by default. When enabled, a read-only dashboard on loopback shows each
     * ranking call as it happens: the goal, the candidate set, every score as a bar,
     * which candidate was chosen, and whether the write that followed verified.
     *
     * It is an observability aid, never a dependency: if the port cannot be bound the
     * tools carry on unaffected.
     */
    enabled: bool("LAYA_VISUALIZER", false),
    host: str("LAYA_VISUALIZER_HOST", "127.0.0.1"),
    port: num("LAYA_VISUALIZER_PORT", 7317, 0, 65_535),
    /** Events retained for the dashboard and the snapshot endpoint. */
    history: num("LAYA_VISUALIZER_HISTORY", 200, 1, 10_000),
  },
} as const;

/** Path to an in-page script, resolved next to the compiled server. */
export function assetPath(...parts: string[]): string {
  return join(distDir, ...parts);
}
