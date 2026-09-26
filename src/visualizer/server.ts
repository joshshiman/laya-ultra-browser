/**
 * Loopback dashboard for the visualizer.
 *
 * A deliberately tiny HTTP server: one HTML page, one SSE stream, one JSON snapshot
 * endpoint. It binds to 127.0.0.1 by default and refuses to start on a busy port
 * rather than killing the tools, because this is an observability aid and must never
 * be the reason a browser task fails.
 */
import { createServer, type Server } from "node:http";
import { config } from "../config.js";
import { log } from "../log.js";
import { configure, snapshot, subscribe, type VisualizerEvent } from "./events.js";
import { DASHBOARD_HTML } from "./dashboard.js";

let server: Server | null = null;
let boundPort = 0;
let boundHost = "127.0.0.1";

export function isRunning(): boolean {
  return server !== null;
}

export function port(): number {
  return boundPort;
}

export function url(): string {
  return `http://${boundHost}:${boundPort}/`;
}

/** Overrides for start(). Config supplies the defaults; these win when present. */
export type VisualizerOptions = {
  enabled?: boolean;
  host?: string;
  port?: number;
  history?: number;
};

/**
 * Starts the dashboard if the feature is enabled.
 *
 * Returns the URL, or null when disabled or when no port could be bound. A failure
 * here is logged and swallowed on purpose: this is an observability aid, and it must
 * never be the reason a browser task fails.
 */
export async function start(options: VisualizerOptions = {}): Promise<string | null> {
  const enabled = options.enabled ?? config.visualizer.enabled;
  if (!enabled) return null;
  if (server) return url();

  const host = options.host ?? config.visualizer.host;
  configure(options.history ?? config.visualizer.history);

  // Try the requested port first, then fall back to any free port. Falling back beats
  // failing: a busy port should cost you the exact URL, not the whole feature.
  let lastError: unknown = null;
  for (const tryPort of [options.port ?? config.visualizer.port, 0]) {
    try {
      const s = await listen(tryPort, host);
      server = s;
      boundHost = host;
      boundPort = (s.address() as { port: number }).port;
      log.info(`visualizer listening on ${url()}`);
      return url();
    } catch (err) {
      lastError = err;
    }
  }

  log.warn(
    `visualizer could not bind a port, continuing without it: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
  return null;
}

function listen(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      try {
        route(req.url ?? "/", res);
      } catch (err) {
        log.debug("visualizer request failed", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("visualizer error");
      }
    });

    s.on("error", reject);
    // Deliberately not a long-lived keep-alive: the dashboard reconnects on its own,
    // and a short timeout reclaims sockets from a closed browser tab.
    s.keepAliveTimeout = 5_000;
    s.headersTimeout = 10_000;

    s.listen(port, host, () => {
      s.off("error", reject);
      resolve(s);
    });
  });
}

function route(url: string, res: import("node:http").ServerResponse): void {
  const path = url.split("?")[0] ?? "/";

  if (path === "/" || path === "/index.html") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (path === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Without this, nginx and some proxies buffer the stream and nothing arrives.
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const send = (event: VisualizerEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of snapshot()) send(event);

    const unsubscribe = subscribe(send);
    // Comment frames keep proxies and the browser from timing out an idle stream.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
    return;
  }

  if (path === "/snapshot") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ events: snapshot() }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

export async function stop(): Promise<void> {
  const s = server;
  server = null;
  boundPort = 0;
  if (!s) return;
  await new Promise<void>((resolve) => {
    // Stop accepting connections, then drop the live SSE responses so the process can
    // exit promptly instead of waiting on keep-alive sockets.
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
  log.info("visualizer stopped");
}
