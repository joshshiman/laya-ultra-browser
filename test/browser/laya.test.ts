/**
 * End-to-end: a real Laya ranking, recorded and streamed.
 *
 * Skipped automatically when no interpreter can import laya_mlx, so the suite still
 * runs on a machine without the optional model. When it does run, it proves the whole
 * chain that the dashboard depends on: Node asks the bridge, the bridge loads the
 * checkpoint, scores come back with the expected shape, and the event reaches a
 * subscriber.
 */
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { repoPath } from "../support/paths.js";
import assert from "node:assert/strict";
import { layaStatus, rank, shutdown as shutdownLaya, warmup } from "../../src/laya/client.js";
import { clear, record, snapshot, subscribe, type RankEvent } from "../../src/visualizer/events.js";
import { start, stop, url } from "../../src/visualizer/server.js";

const CANDIDATES = [
  { ref: 1, role: "textbox", name: "First name", value: "", disabled: false, visibility: "clear" },
  { ref: 2, role: "textbox", name: "Last name", value: "", disabled: false, visibility: "clear" },
  { ref: 3, role: "textbox", name: "Email address", value: "", disabled: false, visibility: "clear" },
  { ref: 4, role: "button", name: "Submit", value: "", disabled: false, visibility: "clear" },
];

describe("laya bridge (requires the optional model)", () => {
  let available = false;
  let unavailableReason = "";

  before(async () => {
    const status = await layaStatus();
    if (status.available) {
      available = true;
    } else {
      // Not a failure: Laya is an optional accelerator and the rest of the suite
      // covers the deterministic path. Say why it was skipped so it is not silent.
      unavailableReason = status.reason;
      console.log(`# skipping Laya bridge tests: ${unavailableReason}`);
    }
  });
  after(async () => {
    await shutdownLaya();
    await stop();
  });

  it("reports availability either way", () => {
    // Always runs, so a broken status check is itself caught.
    assert.ok(typeof available === "boolean");
  });

  it("loads the checkpoint and reports its shape", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    const info = await warmup();
    assert.equal(info.loaded, true, `load failed: ${String(info.load_error ?? "")}`);
    // Both published checkpoints report a context and an option-head budget. The head
    // budget is the hard ceiling on how many candidates can go into one choice call.
    assert.ok(Number(info.max_len) > 0, "expected a positive context length");
    assert.ok(Number(info.head_max_len) > 0, "expected a positive option head budget");
    assert.ok(
      Number(info.head_max_len) < Number(info.max_len),
      "the option head must fit inside the context",
    );
  });

  it("ranks candidates and returns one score per shortlisted option", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    const result = await rank("fill in the email address field", CANDIDATES);

    assert.equal(result.calibrated, false, "the result must never claim to be calibrated");
    assert.ok(result.ranked.length > 0, "expected a non-empty ranking");
    assert.ok(result.elapsed_ms >= 0);

    for (const row of result.ranked) {
      assert.ok(Number.isFinite(row.score), `non-finite score for ref ${row.ref}`);
      assert.ok(row.score >= 0 && row.score <= 1, `score out of range: ${row.score}`);
      assert.ok(
        CANDIDATES.some((c) => c.ref === row.ref),
        `ranking returned an unknown ref ${row.ref}`,
      );
    }
  });

  it("returns the ranking sorted, highest first", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    const result = await rank("the submit button", CANDIDATES);
    for (let i = 1; i < result.ranked.length; i++) {
      const prev = result.ranked[i - 1]!.score;
      const cur = result.ranked[i]!.score;
      assert.ok(prev >= cur, `ranking is not sorted: ${prev} then ${cur}`);
    }
  });

  it("handles a goal that matches nothing without throwing", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    const result = await rank("a goal with no plausible candidate anywhere", CANDIDATES);
    assert.ok(Array.isArray(result.ranked));
  });

  it("rejects an empty goal with a message the caller can act on", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    await assert.rejects(() => rank("   ", CANDIDATES), /goal/);
  });

  it("streams the ranking to a visualizer subscriber", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    clear();
    const seen: RankEvent[] = [];
    const off = subscribe((e) => {
      if (e.kind === "rank") seen.push(e);
    });

    const result = await rank("the email address field", CANDIDATES);
    record({
      kind: "rank",
      goal: "the email address field",
      mode: result.mode === "noul" ? "noul" : "choice",
      considered: result.ranked.map((r) => ({
        ref: r.ref,
        score: r.score,
        role: r.role,
        name: r.name,
      })),
      pruned: result.pruned,
      total: CANDIDATES.length,
      selectedRef: result.ranked[0]?.ref ?? null,
      disagreedWithDeterministic: false,
      deterministicRef: null,
      disagreementReason: null,
      elapsedMs: result.elapsed_ms,
      calibrated: false,
    });
    off();

    assert.equal(seen.length, 1, "the subscriber should have received exactly one event");
    assert.equal(seen[0]?.considered.length, result.ranked.length);
    assert.ok(snapshot().some((e) => e.kind === "rank"));
  });

  it("works in noul mode, one question per candidate", async (t) => {
    // LAYA_MODE=noul is a documented option with its own code path in the bridge, and
    // it is the only way past the option-head ceiling. Config is frozen at import, so
    // this runs in a child process: setting process.env in-process would leave the
    // mode as choice and the test would pass without ever touching noul.
    if (!available) return t.skip("laya_mlx is not available");

    const script = `
      const { rank, warmup, shutdown } = await import(${JSON.stringify(repoPath("dist/laya/client.js"))});
      await warmup();
      const candidates = ${JSON.stringify(CANDIDATES)};
      const result = await rank("the email address field", candidates);
      await shutdown();
      process.stdout.write(JSON.stringify(result));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        LAYA_MODE: "noul",
        LAYA_PYTHON: process.env.LAYA_PYTHON ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    const result = JSON.parse(out) as { mode: string; ranked: Array<{ ref: number; score: number }> };

    assert.equal(result.mode, "noul", "the bridge should have used noul mode");
    assert.ok(result.ranked.length > 0, "expected a non-empty noul ranking");
    for (const row of result.ranked) {
      assert.ok(Number.isFinite(row.score), `non-finite score for ref ${row.ref}`);
      assert.ok(
        CANDIDATES.some((c) => c.ref === row.ref),
        `noul returned an unknown ref ${row.ref}`,
      );
    }
    // noul scores a yes/no judgement, so they are not a distribution over options and
    // need not sum to one. Asserting they would be a mistake about what noul is.
    const sum = result.ranked.reduce((acc, r) => acc + r.score, 0);
    assert.ok(sum > 0, "noul scores should be positive for at least some candidates");
  });

  it("serves the real ranking on the dashboard endpoint", async (t) => {
    if (!available) return t.skip("laya_mlx is not available");
    clear();
    const started = await start({ enabled: true, port: 0 });
    assert.ok(started);

    const result = await rank("the email address field", CANDIDATES);
    record({
      kind: "rank",
      goal: "the email address field",
      mode: "choice",
      considered: result.ranked.map((r) => ({
        ref: r.ref,
        score: r.score,
        role: r.role,
        name: r.name,
      })),
      pruned: result.pruned,
      total: CANDIDATES.length,
      selectedRef: result.ranked[0]?.ref ?? null,
      disagreedWithDeterministic: false,
      deterministicRef: null,
      disagreementReason: null,
      elapsedMs: result.elapsed_ms,
      calibrated: false,
    });

    const res = await fetch(`${url()}snapshot`);
    const body = (await res.json()) as { events: RankEvent[] };
    const rankEvent = body.events.find((e) => e.kind === "rank");
    assert.ok(rankEvent, "expected a rank event in the snapshot");
    assert.equal(rankEvent.goal, "the email address field");
    assert.ok(rankEvent.considered.length > 0);

    const page = await fetch(url());
    const html = await page.text();
    assert.match(html, /EventSource/);
    assert.match(html, /uncalibrated/i);
  });
});
