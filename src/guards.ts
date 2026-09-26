/**
 * Process-level guards.
 *
 * Node's default for an unhandled rejection is to crash. For a long-lived MCP server
 * that is the worst available failure mode: the client sees the transport die with no
 * diagnostic and no chance to retry, often for something incidental like a promise that
 * rejected after its caller had already moved on.
 *
 * The split follows what is actually recoverable. A rejection is almost always a bug or
 * a detached promise nobody is waiting on, and the process is still in a coherent
 * state, so it is logged and the server carries on. An uncaught exception means the
 * process state is unknown, so it is logged with the stack and the process exits
 * non-zero rather than limping along.
 *
 * Kept in its own module so the behaviour can be tested by installing it in a child
 * process and provoking each case, rather than only being asserted by reading it.
 */
import { log } from "./log.js";

export function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    log.error(
      "unhandled promise rejection; the server is continuing because the process is " +
        "still coherent, but this is a bug",
      reason,
    );
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception; exiting because process state is unknown", err);
    // Give the write to stderr a tick to flush before the process goes away.
    setTimeout(() => process.exit(1), 50).unref?.();
  });
}
