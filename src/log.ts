/**
 * Logging.
 *
 * Hard rule: this process speaks JSON-RPC on stdout, so stdout belongs to the MCP
 * transport exclusively. A single stray console.log there corrupts the stream and
 * the client disconnects with a parse error that points nowhere near the cause.
 * Every diagnostic in this file goes to stderr.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LAYA_LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

let thresholdCache: number | null = null;

function enabled(level: LogLevel): boolean {
  if (thresholdCache === null) thresholdCache = threshold();
  return LEVELS[level] >= thresholdCache;
}

function emit(level: LogLevel, msg: string, detail?: unknown): void {
  if (!enabled(level)) return;
  const stamp = new Date().toISOString();
  let line = `${stamp} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (detail !== undefined) {
    let rendered: string;
    if (detail instanceof Error) {
      rendered = detail.stack ?? `${detail.name}: ${detail.message}`;
    } else {
      try {
        rendered = JSON.stringify(detail);
      } catch {
        rendered = String(detail);
      }
    }
    line += `\n${rendered}`;
  }
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, detail?: unknown) => emit("debug", msg, detail),
  info: (msg: string, detail?: unknown) => emit("info", msg, detail),
  warn: (msg: string, detail?: unknown) => emit("warn", msg, detail),
  error: (msg: string, detail?: unknown) => emit("error", msg, detail),
};

/**
 * An error whose message is written for the agent reading the tool response, not
 * for a human reading a log. Carries a hint about what to do next.
 */
export class ActionableError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ActionableError";
    this.hint = hint;
  }
}

/** Normalizes anything thrown into a message plus an optional hint. */
export function describeError(err: unknown): { message: string; hint?: string | undefined } {
  if (err instanceof ActionableError) {
    return { message: err.message, hint: err.hint };
  }
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}` };
  }
  return { message: String(err) };
}
