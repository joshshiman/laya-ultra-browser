/**
 * Visualizer: the event buffer, the loopback server, and the SSE stream.
 *
 * These tests run with LAYA_VISUALIZER off for most cases and start the server
 * explicitly, so the suite never depends on the developer's own configuration.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  clear,
  configure,
  record,
  snapshot,
  subscribe,
  subscriberCount,
  type RankEvent,
} from "../../src/visualizer/events.js";
import { isRunning, start, stop, url } from "../../src/visualizer/server.js";

import { release } from "../../src/browser.js";

describe("visualizer event buffer", () => {
  beforeEach(() => {
    clear();
    configure(100);
  });

  it("assigns an id and a timestamp", () => {
    const ev = record({
      kind: "rank",
      goal: "the email field",
      mode: "choice",
      considered: [{ ref: 1, score: 0.5, role: "textbox", name: "Email" }],
      pruned: 0,
      total: 1,
      selectedRef: 1,
      disagreedWithDeterministic: false,
      deterministicRef: null,
      disagreementReason: null,
      elapsedMs: 12,
      calibrated: false,
    });
    assert.equal(ev.id, 1);
    assert.ok(ev.at > 0);
  });

  it("keeps events in order", () => {
    for (let i = 0; i < 3; i++) {
      record({
        kind: "note",
        level: "info",
        message: `n${i}`,
      });
    }
    assert.deepEqual(
      snapshot().map((e) => (e.kind === "note" ? e.message : "")),
      ["n0", "n1", "n2"],
    );
  });

  it("drops the oldest events past the limit", () => {
    // A long session must not grow without bound, so the buffer is a ring.
    configure(3);
    for (let i = 0; i < 10; i++) {
      record({ kind: "note", level: "info", message: `n${i}` });
    }
    const kept = snapshot();
    assert.equal(kept.length, 3);
    assert.deepEqual(
      kept.map((e) => (e.kind === "note" ? e.message : "")),
      ["n7", "n8", "n9"],
    );
  });

  it("treats a nonsensical limit as one rather than zero", () => {
    // A zero or negative limit would make every record a no-op, which looks like the
    // visualizer is silently broken.
    configure(0);
    record({ kind: "note", level: "info", message: "kept" });
    assert.equal(snapshot().length, 1);
  });

  it("fans out to subscribers and stops after unsubscribe", () => {
    const seen: number[] = [];
    const off = subscribe((e) => seen.push(e.id));
    record({ kind: "note", level: "info", message: "a" });
    off();
    record({ kind: "note", level: "info", message: "b" });
    assert.equal(seen.length, 1);
  });

  it("survives a subscriber that throws", () => {
    // Observability must never be able to fail the tool call that produced the event.
    const good: number[] = [];
    subscribe(() => {
      throw new Error("subscriber is broken");
    });
    subscribe((e) => good.push(e.id));
    assert.doesNotThrow(() => record({ kind: "note", level: "info", message: "x" }));
    assert.equal(good.length, 1);
  });

  it("hands out a copy, not the live array", () => {
    record({ kind: "note", level: "info", message: "a" });
    const first = snapshot();
    first.push({ kind: "note", id: 99, at: 0, level: "info", message: "injected" });
    assert.equal(snapshot().length, 1);
  });

  it("tracks subscriber count", () => {
    const before = subscriberCount();
    const off = subscribe(() => {});
    assert.equal(subscriberCount(), before + 1);
    off();
    assert.equal(subscriberCount(), before);
  });
});

describe("visualizer http server", () => {
  after(async () => {
    await stop();
    await release();
  });

  it("stays down when disabled", async () => {
    // No port is opened and start() reports it did nothing. This is the default state,
    // and it is what keeps the feature from being a liability.
    const result = await start({ enabled: false });
    assert.equal(result, null);
    assert.equal(isRunning(), false);
  });

  it("serves the dashboard", async () => {
    // Port 0 asks the OS for a free port, so the suite never collides with a real one.
    const started = await start({ enabled: true, port: 0 });
    assert.ok(started, "expected the visualizer to start");
    assert.equal(isRunning(), true);
    assert.match(started, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const res = await fetch(started);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /laya-ultra-browser/);
    // The honesty banner has to be in the served page, not just in the docs.
    assert.match(body, /uncalibrated/i);
  });

  it("falls back to another port when the requested one is taken", async () => {
    // Losing the exact port is a much better outcome than losing the feature, so
    // start() retries on port 0 before giving up.
    await stop();

    // Occupy a port with an unrelated listener.
    const blocker = createServer();
    const takenPort = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as { port: number }).port);
      });
    });

    try {
      const started = await start({ enabled: true, port: takenPort });
      assert.ok(started, "expected the visualizer to start on a fallback port");
      assert.notEqual(new URL(started).port, String(takenPort));

      // And it must actually be serving on the new port.
      const res = await fetch(started);
      assert.equal(res.status, 200);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("is idempotent: starting twice keeps the first server", async () => {
    const first = await start({ enabled: true, port: 0 });
    assert.ok(first);
    const second = await start({ enabled: true, port: 0 });
    assert.equal(second, first, "a second start must not spin up a second listener");
  });

  it("serves the retained history as JSON", async () => {
    clear();
    configure(50);
    record({ kind: "note", level: "info", message: "hello from the test" });
    const res = await fetch(`${url()}snapshot`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: Array<{ message?: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.message, "hello from the test");
  });

  it("404s an unknown path", async () => {
    const res = await fetch(`${url()}nope`);
    assert.equal(res.status, 404);
  });

  it("streams new events over SSE", async () => {
    const controller = new AbortController();
    const res = await fetch(`${url()}events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);

    const received: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read whatever backlog the server sends on connect, plus one live event.
    const pump = (async () => {
      while (received.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (line.startsWith("data: ")) received.push(line.slice(6));
        }
      }
    })();

    record({
      kind: "rank",
      goal: "the submit button",
      mode: "choice",
      considered: [{ ref: 7, score: 0.62, role: "button", name: "Submit" }],
      pruned: 2,
      total: 9,
      selectedRef: 7,
      disagreedWithDeterministic: false,
      deterministicRef: null,
      disagreementReason: null,
      elapsedMs: 97,
      calibrated: false,
    });

    await pump;
    controller.abort();
    assert.ok(received.length >= 1, "expected at least one SSE frame");
    const parsed = JSON.parse(received[received.length - 1]!) as Partial<RankEvent>;
    assert.equal(parsed.kind, "rank");
    assert.equal(parsed.goal, "the submit button");
    assert.equal(parsed.considered?.[0]?.name, "Submit");
  });
});
