/**
 * Node side of the Laya bridge.
 *
 * Responsibilities, in order of importance:
 *   1. Be optional. If no interpreter can import laya_mlx, every other tool must keep
 *      working and only the Laya path reports itself unavailable. A missing optional
 *      accelerator is never a reason for the server to fail.
 *   2. Never hang. Every request has a timeout, and a bridge that dies mid-call is
 *      reported as a failure rather than leaving the caller waiting.
 *   3. Never lose an error. The bridge reports failures as data; they are turned into
 *      ActionableError with the interpreter path and the fix.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { config, assetPath } from "../config.js";
import { ActionableError, log } from "../log.js";

export type RankedCandidate = {
  ref: number;
  score: number;
  role: string | null;
  name: string | null;
};

export type RankResult = {
  ranked: RankedCandidate[];
  pruned: number;
  mode: string;
  elapsed_ms: number;
  calibrated: false;
};

export type LayaStatus =
  | { available: true; python: string; model: string; checkpoint: string | null; maxLen?: number; headMaxLen?: number; loadSeconds?: number | null }
  | { available: false; reason: string; hint: string; tried: string[] };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let child: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let resolvedPython: string | null = null;
let buffer = "";
let nextId = 1;
const pending = new Map<number, Pending>();
let lastInfo: Record<string, unknown> | null = null;

const SETUP_HINT =
  "Run the bundled setup script to create an isolated Laya environment: npm run setup:laya";

/** Candidate interpreter paths to try, most specific first. */
function interpreterCandidates(): string[] {
  const out: string[] = [];
  if (process.env.LAYA_PYTHON) out.push(process.env.LAYA_PYTHON);
  else out.push(config.laya.python);
  for (const name of config.laya.fallbackPythons) out.push(name);
  return [...new Set(out)];
}

/** Runs `python -c "import laya_mlx"` to see whether an interpreter can load Laya. */
function probe(python: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    const proc = spawn(python, ["-c", "import laya_mlx, sys; print(laya_mlx.__version__)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(false, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();
    proc.on("error", (e) => finish(false, e.message));
    proc.on("close", (code) => {
      if (code === 0) finish(true, out.trim());
      else finish(false, (err.trim() || `exited ${code}`).split("\n").slice(-2).join(" "));
    });
  });
}

let cachedStatus: LayaStatus | null = null;

/** Resolves once and caches whether Laya is usable, including which interpreter works. */
export async function layaStatus(force = false): Promise<LayaStatus> {
  if (cachedStatus && !force) return cachedStatus;

  if (!config.laya.enabled) {
    cachedStatus = {
      available: false,
      reason: "Laya is disabled by LAYA_ENABLED=false",
      hint: "Unset LAYA_ENABLED, or set it to true, to use local Laya ranking.",
      tried: [],
    };
    return cachedStatus;
  }

  const tried: string[] = [];
  for (const python of interpreterCandidates()) {
    tried.push(python);
    const resolved = await resolveInterpreter(python);
    if (!resolved.exists) {
      log.debug(`laya: ${python} is not a usable interpreter path`);
      continue;
    }
    const result = await probe(resolved.path, Math.min(config.laya.startupTimeoutMs, 30_000));
    if (result.ok) {
      resolvedPython = resolved.path;
      cachedStatus = {
        available: true,
        python: resolved.path,
        model: config.laya.model,
        checkpoint: config.laya.checkpoint || null,
      };
      log.info(`laya available via ${resolved.path} (laya_mlx ${result.detail})`);
      return cachedStatus;
    }
    log.debug(`laya: ${python} cannot import laya_mlx: ${result.detail}`);
  }

  cachedStatus = {
    available: false,
    reason:
      "No Python interpreter on this machine can import laya_mlx, so local Laya ranking is unavailable. Every other tool works without it.",
    hint: SETUP_HINT,
    tried,
  };
  return cachedStatus;
}

async function resolveInterpreter(python: string): Promise<{ path: string; exists: boolean }> {
  if (python.includes("/") || python.includes("\\")) {
    return { path: python, exists: existsSync(python) };
  }
  // Bare name: let the OS resolve it via PATH.
  return { path: python, exists: true };
}

function bridgeScript(): string {
  return assetPath("laya", "bridge.py");
}

function startBridge(python: string): Promise<void> {
  const script = bridgeScript();
  if (!existsSync(script)) {
    return Promise.reject(
      new ActionableError(
        `The Laya bridge script is missing at ${script}.`,
        "The build did not copy src/laya into dist/. Run: npm run build",
      ),
    );
  }

  return new Promise<void>((resolve, reject) => {
    log.info(`starting laya bridge: ${python} ${script}`);
    const proc = spawn(python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LAYA_MODEL: config.laya.model,
        LAYA_CHECKPOINT: config.laya.checkpoint,
        // Keep BLAS thread counts sane; MLX owns the GPU.
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "4",
      },
    });
    child = proc;

    let stderrTail = "";
    proc.stderr.on("data", (d: Buffer) => {
      const text = String(d);
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split("\n")) {
        if (line.trim()) log.debug(`bridge: ${line}`);
      }
    });

    proc.stdout.on("data", (d: Buffer) => {
      buffer += String(d);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: { id?: number; ok?: boolean; error?: string };
        try {
          frame = JSON.parse(line);
        } catch {
          log.warn(`bridge emitted a non-JSON line, ignoring: ${line.slice(0, 200)}`);
          continue;
        }
        const entry = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
        if (!entry) continue;
        pending.delete(frame.id!);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame);
        else {
          entry.reject(
            new ActionableError(
              `Laya bridge reported: ${frame.error ?? "unknown error"}`,
              stderrTail.trim() ? `Bridge stderr: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}` : undefined,
            ),
          );
        }
      }
    });

    proc.on("error", (err) => {
      ready = null;
      child = null;
      reject(
        new ActionableError(
          `Could not start the Laya bridge with ${python}: ${err.message}`,
          SETUP_HINT,
        ),
      );
    });

    proc.on("exit", (code, signal) => {
      log.info(`laya bridge exited (code=${code} signal=${signal})`);
      child = null;
      ready = null;
      const err = new ActionableError(
        `The Laya bridge stopped unexpectedly (code=${code}, signal=${signal}).`,
        stderrTail.trim()
          ? `Last bridge output: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}`
          : SETUP_HINT,
      );
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    });

    // The bridge prints "laya bridge ready" on stderr once it is listening.
    const startupTimer = setTimeout(() => {
      if (child === proc && ready !== null) {
        ready = null;
        proc.kill("SIGKILL");
        reject(
          new ActionableError(
            `The Laya bridge did not become ready within ${config.laya.startupTimeoutMs}ms.`,
            stderrTail.trim()
              ? `Last bridge output: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}. First run downloads roughly 2GB of model weights.`
              : SETUP_HINT,
          ),
        );
      }
    }, config.laya.startupTimeoutMs);
    startupTimer.unref?.();

    const onReadyLine = (d: Buffer) => {
      if (String(d).includes("laya bridge ready")) {
        clearTimeout(startupTimer);
        proc.stderr.off("data", onReadyLine);
        resolve();
      }
    };
    proc.stderr.on("data", onReadyLine);
  });
}

async function ensureBridge(): Promise<ChildProcessWithoutNullStreams> {
  if (child) return child;
  if (ready) {
    await ready;
    if (child) return child;
  }
  const status = await layaStatus();
  if (!status.available) {
    throw new ActionableError(status.reason, status.hint);
  }
  ready = startBridge(status.python);
  try {
    await ready;
  } finally {
    ready = null;
  }
  if (!child) throw new ActionableError("The Laya bridge failed to start.");
  return child;
}

function request(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = await ensureBridge();
      } catch (err) {
        reject(err);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new ActionableError(
            `The Laya bridge did not answer within ${timeoutMs}ms.`,
            "A cold model on the first call can be slow. Raise LAYA_REQUEST_TIMEOUT_MS, or check that nothing else is saturating the GPU.",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/**
 * Ranks candidates against a goal. Throws ActionableError when Laya is unavailable, so
 * callers can decide between falling back to deterministic matching or surfacing the
 * problem to the agent.
 */
export async function rank(
  goal: string,
  candidates: Array<Record<string, unknown>>,
): Promise<RankResult> {
  const frame = await request(
    {
      op: "rank",
      goal,
      candidates,
      mode: config.laya.mode,
      max_options: config.laya.maxOptions,
      max_candidates: config.laya.maxCandidates,
    },
    config.laya.requestTimeoutMs,
  );
  return {
    ranked: (frame.ranked ?? []) as RankedCandidate[],
    pruned: (frame.pruned ?? 0) as number,
    mode: (frame.mode ?? config.laya.mode) as string,
    elapsed_ms: (frame.elapsed_ms ?? 0) as number,
    calibrated: false,
  };
}

/** Warms the bridge and loads the model so the first real call is fast. */
export async function warmup(): Promise<Record<string, unknown>> {
  const frame = await request({ op: "info" }, config.laya.startupTimeoutMs);
  lastInfo = (frame.info as Record<string, unknown>) ?? null;
  return lastInfo ?? {};
}

export function cachedInfo(): Record<string, unknown> | null {
  return lastInfo;
}

export async function shutdown(): Promise<void> {
  const proc = child;
  child = null;
  ready = null;
  if (!proc) return;
  try {
    proc.stdin.write(JSON.stringify({ id: 0, op: "shutdown" }) + "\n");
    // Give it a moment to exit cleanly, then make sure it is gone.
    await new Promise<void>((r) => setTimeout(r, 100));
    if (!proc.killed) proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}
