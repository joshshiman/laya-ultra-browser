/**
 * The disagreement between the model and the deterministic matcher.
 *
 * The objective for the visualizer is that disagreements are made visible rather than
 * hidden, which is only meaningful if they are actually detected. These cover the two
 * pure pieces: spotting a flat distribution, and picking the deterministic winner that
 * the comparison is made against.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestDeterministic, deterministicScore, spread } from "../../src/select.js";
import type { SnapshotElement } from "../../src/page.js";

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

describe("score spread", () => {
  it("is zero when every candidate scored the same", () => {
    // This is the shape the default checkpoint returns on a page of unrelated
    // controls, and the reason a flat ranking must not be treated as a decision.
    assert.equal(spread([{ score: 0.73 }, { score: 0.73 }, { score: 0.73 }]), 0);
  });

  it("is the gap between the highest and lowest", () => {
    assert.equal(spread([{ score: 0.9 }, { score: 0.4 }, { score: 0.1 }]), 0.8);
  });

  it("is zero for an empty ranking", () => {
    assert.equal(spread([]), 0);
  });

  it("is zero for a single candidate", () => {
    assert.equal(spread([{ score: 0.99 }]), 0);
  });

  it("handles a single confident candidate without reading as flat", () => {
    // One candidate is not a flat distribution in the sense that matters: there is
    // nothing to confuse it with. The caller only compares when it has alternatives.
    assert.equal(spread([{ score: 0.99 }, { score: 0.99 }]), 0);
  });
});

describe("deterministic winner", () => {
  const form = [
    el({ ref: 1, name: "First name", role: "textbox" }),
    el({ ref: 2, name: "Last name", role: "textbox" }),
    el({ ref: 3, name: "Email address", role: "textbox" }),
    el({ ref: 4, name: "Submit", role: "button" }),
  ];

  it("picks the element whose name matches the goal", () => {
    const best = bestDeterministic("the email address field", form);
    assert.equal(best?.ref, 3);
  });

  it("reports the score so a comparison against the model is meaningful", () => {
    const best = bestDeterministic("the email address field", form);
    assert.ok(best);
    assert.equal(best.score, deterministicScore("the email address field", form[2]!));
  });

  it("returns null for an empty page rather than a bogus ref", () => {
    assert.equal(bestDeterministic("anything", []), null);
  });

  it("names an unnamed element rather than returning an empty label", () => {
    const best = bestDeterministic("the field", [el({ ref: 9, name: "", role: "textbox", tag: "input" })]);
    assert.equal(best?.name, "(input)");
  });

  it("disagrees with a confidently wrong model pick", () => {
    // The exact situation observed in practice: the model chose a button at 0.9986 for
    // a field goal. The comparison has to notice, because that is the signal a user
    // needs before trusting a probabilistic pick.
    const modelPick = 4; // "Submit", a button
    const best = bestDeterministic("the email address field", form);
    assert.notEqual(best?.ref, modelPick, "the two should disagree for this case to be interesting");
  });
});
