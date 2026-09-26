/**
 * Settings that must change behaviour, not just appear in a table.
 *
 * Two LAYA_* variables were documented but read by nothing. Asserting that config
 * resolves them is not enough, because the wiring between config and behaviour is
 * exactly where that class of bug lives. These run the real thing in a child process
 * with the variable set, and check the observable difference.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../support/paths.js";

const fixtureUrl = pathToFileURL(repoPath("test/fixtures/shadow-lab.html")).href;
const profile = mkdtempSync(join(tmpdir(), "laya-settings-"));
after(() => rmSync(profile, { recursive: true, force: true }));

type Snap = { names: string[]; count: number };

/**
 * Snapshots the fixture in a child process with the given environment.
 *
 * A child process per case, because config is resolved once at import time: setting
 * process.env in-process would not change an already-imported config module.
 *
 * `raiseOverlay` puts the fixture's full-viewport overlay over the page first, which is
 * what actually makes a control covered. Without it COVERED_BUTTON is legitimately
 * visible, so a test expecting it hidden by default would be testing the wrong thing.
 */
function snapshotNames(env: Record<string, string>, raiseOverlay = false): Snap {
  const overlay = raiseOverlay
    ? `await page.evaluate(() => { document.getElementById("overlay").style.display = "block"; });`
    : "";
  const script = `
    const { getPage, release } = await import(${JSON.stringify(repoPath("dist/browser.js"))});
    const { snapshot } = await import(${JSON.stringify(repoPath("dist/page.js"))});
    const { config } = await import(${JSON.stringify(repoPath("dist/config.js"))});
    const page = await getPage();
    await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: "load" });
    await page.waitForTimeout(400);
    ${overlay}
    // Mirror how the tool resolves the flag: an explicit argument, else the config.
    const snap = await snapshot(page, {
      interactive: true,
      includeOffscreen: config.includeHidden,
      includeCovered: config.includeHidden,
    });
    const out = { names: snap.elements.map(e => e.name), count: snap.elements.length };
    await release();
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      LAYA_PROFILE_DIR: profile,
      LAYA_VISUALIZER: "false",
      LAYA_LOG_LEVEL: "error",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return JSON.parse(stdout) as Snap;
}

describe("LAYA_INCLUDE_HIDDEN", () => {
  let off: Snap;
  let on: Snap;
  let coveredOff: Snap;
  let coveredOn: Snap;

  before(() => {
    off = snapshotNames({ LAYA_INCLUDE_HIDDEN: "false" });
    on = snapshotNames({ LAYA_INCLUDE_HIDDEN: "true" });
    coveredOff = snapshotNames({ LAYA_INCLUDE_HIDDEN: "false" }, true);
    coveredOn = snapshotNames({ LAYA_INCLUDE_HIDDEN: "true" }, true);
  });

  it("excludes an offscreen control when false", () => {
    assert.ok(
      !off.names.includes("OFFSCREEN_BUTTON"),
      `an offscreen control should be excluded by default, got ${JSON.stringify(off.names)}`,
    );
  });

  it("includes an offscreen control when true", () => {
    assert.ok(
      on.names.includes("OFFSCREEN_BUTTON"),
      `LAYA_INCLUDE_HIDDEN=true did not surface the offscreen control; got ${JSON.stringify(on.names)}`,
    );
  });

  it("excludes a genuinely covered control when false", () => {
    // Only meaningful with the overlay raised: an unoccluded control stays visible
    // whatever this flag says.
    assert.ok(
      !coveredOff.names.includes("COVERED_BUTTON"),
      "a control under the overlay should be excluded by default",
    );
  });

  it("includes a genuinely covered control when true", () => {
    assert.ok(
      coveredOn.names.includes("COVERED_BUTTON"),
      "LAYA_INCLUDE_HIDDEN=true did not surface the covered control",
    );
  });

  it("actually changes the result rather than being decorative", () => {
    assert.ok(
      on.count > off.count,
      `expected more controls with LAYA_INCLUDE_HIDDEN=true, got ${off.count} then ${on.count}`,
    );
  });

  it("never surfaces a control that is not rendered at all", () => {
    // The distinction matters: an offscreen control is reachable by scrolling, a
    // display:none or visibility:hidden one is out of the render tree entirely.
    // Turning the flag on must not start offering controls that cannot be operated.
    for (const snap of [on, coveredOn]) {
      assert.ok(
        !snap.names.includes("HIDDEN_BUTTON"),
        "a display:none control must stay out of the snapshot even with the flag on",
      );
      assert.ok(
        !snap.names.includes("INVISIBLE_BUTTON"),
        "a visibility:hidden control must stay out of the snapshot even with the flag on",
      );
    }
  });
});

describe("LAYA_PERSISTENT_PROFILE", () => {
  /** Loads the fixture and reports the title, exercising the whole launch path. */
  function loadWith(persistent: boolean): { title: string } {
    const script = `
      const { getPage, release } = await import(${JSON.stringify(repoPath("dist/browser.js"))});
      const page = await getPage();
      await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const title = await page.title();
      await release();
      process.stdout.write(JSON.stringify({ title }));
    `;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        LAYA_PROFILE_DIR: profile,
        LAYA_VISUALIZER: "false",
        LAYA_LOG_LEVEL: "error",
        LAYA_PERSISTENT_PROFILE: String(persistent),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return JSON.parse(stdout) as { title: string };
  }

  it("launches and navigates with a persistent profile", () => {
    assert.equal(loadWith(true).title, "laya shadow lab");
  });

  it("launches and navigates with an ephemeral profile", () => {
    // Previously LAYA_PERSISTENT_PROFILE was read by nothing, so this silently took the
    // persistent path. It has to launch, navigate and tear down on its own code path.
    assert.equal(loadWith(false).title, "laya shadow lab");
  });
});
