/**
 * Chromium lifecycle.
 *
 * One browser, one page, launched lazily on first use so that merely starting the
 * MCP server does not pop a browser window. Everything that can fail during a task
 * -- launch, navigation, teardown -- gets an explicit timeout and an error message
 * that says what to do about it.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { ActionableError, log } from "./log.js";

/** Set on the page object so we know whether an init script is already installed. */
const INJECTED = Symbol.for("laya-ultra-browser.injected");

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let launching: Promise<BrowserContext> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lastActivity = Date.now();
let closed = false;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  if (config.idleTimeoutMs <= 0 || closed) return;
  idleTimer = setTimeout(() => {
    const idleFor = Date.now() - lastActivity;
    if (idleFor < config.idleTimeoutMs) {
      armIdleTimer();
      return;
    }
    log.info(`idle for ${Math.round(idleFor / 1000)}s, releasing the browser`);
    // Release rather than shut down. An idle timeout must leave the server able to
    // relaunch on the next call, not permanently closed.
    void release().catch((err) => log.warn("idle release failed", err));
  }, config.idleTimeoutMs);
  // Do not hold the event loop open just for the idle timer.
  idleTimer.unref?.();
}

export function touch(): void {
  lastActivity = Date.now();
  armIdleTimer();
}

async function launchContext(): Promise<BrowserContext> {
  const args: string[] = [];
  if (config.headed === false) {
    // Keep background timers throttled in headless so pages behave closer to headed.
    args.push("--disable-background-timer-throttling");
    args.push("--disable-backgrounding-occluded-windows");
    args.push("--disable-renderer-backgrounding");
  }

  const shared = {
    headless: !config.headed,
    args,
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
  };

  if (!config.persistentProfile) {
    // Ephemeral: a throwaway profile, discarded on exit. Leaves nothing on disk, but
    // every session starts signed out, so any login has to be redone. launch() returns
    // a Browser, so take a context from it to keep one shape for the caller.
    const launched = await chromium.launch(shared);
    return launched.newContext();
  }

  // Persistent: the profile directory is reused between runs, so a login survives.
  return chromium.launchPersistentContext(config.profileDir, shared);
}

async function ensureBrowser(): Promise<BrowserContext> {
  if (closed) {
    throw new ActionableError("The server is shutting down and cannot open a page.");
  }
  if (context) return context;
  if (launching) return launching;

  launching = (async () => {
    log.info(`launching chromium (headless=${!config.headed}, profile=${config.profileDir})`);
    let ctx: BrowserContext;
    try {
      ctx = await withTimeout(
        launchContext(),
        config.callTimeoutMs,
        "Chromium did not start within the launch timeout",
        "A cold first launch on a slow disk can exceed this. Raise LAYA_CALL_TIMEOUT_MS, or check whether the browser is being downloaded at the same time.",
      );
    } catch (err) {
      launching = null;
      throw explainLaunchFailure(err);
    }

    // A persistent context already owns a browser; grab it for the close path.
    browser = ctx.browser();
    context = ctx;

    ctx.on("close", () => {
      log.info("browser context closed");
      context = null;
      page = null;
    });

    const existing = ctx.pages();
    page = existing[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(config.callTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    armIdleTimer();
    log.info("chromium ready");
    return ctx;
  })();

  // Hold the promise locally: clearing the module-level `launching` in the finally
  // block would otherwise narrow it to null before this return is type-checked.
  const pending = launching;
  try {
    return await pending;
  } finally {
    if (launching === pending) launching = null;
  }
}

/** The active page, launching the browser if needed. */
export async function getPage(): Promise<Page> {
  touch();
  const ctx = await ensureBrowser();
  if (!page || page.isClosed()) {
    page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(config.callTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  }
  return page;
}

/** True when a browser is already running, without launching one. */
export function isRunning(): boolean {
  return context !== null;
}

export async function navigate(
  url: string,
): Promise<{ url: string; title: string; status: number | null }> {
  const p = await getPage();
  const target = normalizeUrl(url);
  try {
    const response = await p.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    // Give custom elements a chance to upgrade and attach shadow roots before the
    // caller snapshots. A snapshot taken too early under-reports shadow controls,
    // which reads as "the control does not exist" rather than "it has not mounted".
    await p.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    await p.waitForTimeout(150);
    touch();
    return {
      url: p.url(),
      title: await p.title().catch(() => ""),
      status: response?.status() ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ActionableError(
      `Navigation to ${target} failed: ${msg}`,
      msg.includes("Timeout")
        ? `The page did not reach domcontentloaded within ${config.navigationTimeoutMs}ms. Raise LAYA_NAVIGATION_TIMEOUT_MS if it is genuinely slow, or check the URL.`
        : "Check the URL is reachable from this machine and not blocked by a proxy or TLS interception.",
    );
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^localhost(:\d+)?(\/|$)/.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/**
 * Turns a raw Playwright launch failure into something a user can act on.
 *
 * Playwright's own message for a missing browser is a box-drawn banner telling you to
 * run `npx playwright install`, which is not enough: it does not say where to run it,
 * and browsers are cached per Playwright version, so running it in the wrong directory
 * installs the wrong revision and the error does not go away. The rest of Playwright's
 * failures are passed through with their own text intact.
 */
function explainLaunchFailure(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const message = err.message;
  if (!/Executable doesn't exist|browserType\.launch.*executable/i.test(message)) {
    return err;
  }
  return new ActionableError(
    "The Chromium build this server needs is not installed.",
    "Playwright caches browsers per version, so install the one this copy of the package " +
      "expects. Run this in the laya-ultra-browser package directory, not an unrelated one:\n\n" +
      "    npx playwright install chromium\n\n" +
      "Or point the server at a Chrome you already have, with LAYA_CHROME_PATH=" +
      "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome.",
  );
}

/** Rejects with an actionable timeout error if the promise does not settle in time. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  hint?: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ActionableError(`${what} timed out after ${ms}ms.`, hint)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Closes the browser but leaves the server able to launch a new one.
 *
 * Used by the idle timer. Distinct from shutdown() because shutdown is terminal: once
 * it has run, any further tool call must fail rather than silently resurrect a browser
 * in a process that is on its way out.
 */
export async function release(): Promise<void> {
  clearIdleTimer();
  const ctx = context;
  const ctxBrowser = browser;
  context = null;
  browser = null;
  page = null;
  try {
    // Close the context first: for a persistent context that also closes the browser.
    await ctx?.close();
  } catch (err) {
    log.debug("context close failed", err);
  }
  try {
    if (ctxBrowser) await ctxBrowser.close();
  } catch (err) {
    log.debug("browser close failed", err);
  }
  log.info("browser released");
}

/** Terminal teardown. After this, no further page can be opened. */
export async function shutdown(): Promise<void> {
  if (closed) return;
  closed = true;
  await release();
  log.info("browser shut down");
}

/** Installs signal handlers so a killed MCP host does not orphan a browser. */
export function installSignalHandlers(): void {
  const bail = (signal: string) => {
    void (async () => {
      log.info(`received ${signal}, cleaning up`);
      await shutdown();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => bail("SIGINT"));
  process.on("SIGTERM", () => bail("SIGTERM"));
  // A parent that closes the pipe should not leave a Chromium behind.
  process.stdin.on("close", () => {
    void (async () => {
      log.info("stdin closed, cleaning up");
      await shutdown();
      process.exit(0);
    })();
  });
}
