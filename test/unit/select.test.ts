/**
 * The deterministic fallback matcher.
 *
 * This is the path that runs when Laya is unavailable, so it is the only thing standing
 * between a goal like "the email field" and a click on the wrong control. It has to be
 * predictable, which means these tests pin its behaviour rather than its internals.
 *
 * The scoring function is pure, so it is tested directly. Testing it through a stubbed
 * Playwright page would only assert that the stub is shaped correctly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicScore, resolveTarget } from "../../src/select.js";
import type { SnapshotElement } from "../../src/page.js";
import type { Page } from "playwright";

function el(
  partial: Partial<SnapshotElement> & { ref: number; name: string; role: string },
): SnapshotElement {
  return {
    tag: "input",
    value: "",
    disabled: false,
    shadowDepth: 0,
    frameDepth: 0,
    visibility: "clear",
    box: { x: 0, y: 0, w: 100, h: 20 },
    ...partial,
  } as SnapshotElement;
}

/** Picks the highest-scoring element, the way resolveTarget does. */
function best(goal: string, elements: SnapshotElement[]): SnapshotElement {
  return [...elements].sort((a, b) => deterministicScore(goal, b) - deterministicScore(goal, a))[0]!;
}

describe("deterministic goal matching", () => {
  it("scores a name that matches the goal above one that does not", () => {
    const goal = "the email address field";
    const match = el({ ref: 3, name: "Email address", role: "textbox" });
    const other = el({ ref: 1, name: "First name", role: "textbox" });
    assert.ok(
      deterministicScore(goal, match) > deterministicScore(goal, other),
      "a matching name must outscore a non-matching one",
    );
  });

  it("picks the email field out of a mixed form", () => {
    const elements = [
      el({ ref: 1, name: "First name", role: "textbox" }),
      el({ ref: 2, name: "Last name", role: "textbox" }),
      el({ ref: 3, name: "Email address", role: "textbox" }),
      el({ ref: 4, name: "Submit", role: "button" }),
    ];
    assert.equal(best("the email address field", elements).ref, 3);
  });

  it("scores a disabled control below an identical enabled one", () => {
    const goal = "email address";
    const disabled = el({ ref: 1, name: "Email address", role: "textbox", disabled: true });
    const enabled = el({ ref: 2, name: "Email address", role: "textbox" });
    assert.ok(deterministicScore(goal, enabled) > deterministicScore(goal, disabled));
  });

  it("penalises an offscreen or covered control", () => {
    const goal = "email address";
    const offscreen = el({ ref: 1, name: "Email address", role: "textbox", visibility: "offscreen" });
    const clear = el({ ref: 2, name: "Email address", role: "textbox", visibility: "clear" });
    assert.ok(deterministicScore(goal, clear) > deterministicScore(goal, offscreen));
  });

  it("prefers a textbox when the goal implies typing", () => {
    const goal = "type into the search field";
    const asButton = el({ ref: 1, name: "Search this feed", role: "button" });
    const asSearchbox = el({ ref: 2, name: "Search this feed", role: "searchbox" });
    assert.ok(deterministicScore(goal, asSearchbox) > deterministicScore(goal, asButton));
  });

  it("prefers a button when the goal implies clicking", () => {
    const goal = "click the save button";
    const asButton = el({ ref: 1, name: "Save", role: "button" });
    const asTextbox = el({ ref: 2, name: "Save", role: "textbox" });
    assert.ok(deterministicScore(goal, asButton) > deterministicScore(goal, asTextbox));
  });

  it("is not fooled by a goal made only of stop words", () => {
    // "the field" carries no signal. Every candidate should score the same, so the
    // caller sees a genuine tie and reports ambiguity rather than a confident guess.
    const elements = [
      el({ ref: 1, name: "Alpha", role: "textbox" }),
      el({ ref: 2, name: "Beta", role: "textbox" }),
    ];
    assert.equal(deterministicScore("the field", elements[0]!), deterministicScore("the field", elements[1]!));
  });

  it("ignores the case and punctuation of the goal", () => {
    const a = deterministicScore("Email Address", el({ ref: 1, name: "Email address", role: "textbox" }));
    const b = deterministicScore("  email, address!  ", el({ ref: 1, name: "Email address", role: "textbox" }));
    assert.equal(a, b);
  });

  it("handles an element with no accessible name", () => {
    // Real pages are full of nameless controls. This must not throw or go NaN.
    const score = deterministicScore("email address", el({ ref: 1, name: "", role: "textbox" }));
    assert.ok(Number.isFinite(score), `expected a finite score, got ${score}`);
  });
});

describe("resolveTarget preconditions", () => {
  const noPage = {} as Page;

  it("requires a goal or a ref", async () => {
    await assert.rejects(
      () => resolveTarget({ page: noPage, deterministic: true }),
      /Provide either a ref or a goal/,
    );
  });

  it("passes an explicit ref straight through without touching the page", async () => {
    // A ref is exact, so it must not cost a snapshot or a model call. The empty page
    // object proves neither happens: any page access would throw.
    const proposal = await resolveTarget({ page: noPage, ref: 42 });
    assert.equal(proposal.ref, 42);
    assert.equal(proposal.via, "explicit-ref");
    assert.deepEqual(proposal.target, { ref: 42 });
    assert.deepEqual(proposal.alternatives, []);
  });

  it("rejects a whitespace-only goal rather than matching everything", async () => {
    await assert.rejects(
      () => resolveTarget({ page: noPage, goal: "   ", deterministic: true }),
      /Provide either a ref or a goal/,
    );
  });
});
