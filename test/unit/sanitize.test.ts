/**
 * The model's output is not trusted.
 *
 * Laya is a black box, and its response is cast through a subprocess boundary. What
 * matters is not that it is usually well-formed but that a malformed response cannot
 * be mistaken for a confident answer: a NaN score makes every threshold comparison
 * false, so without validation garbage reads as decided and unambiguous, which is the
 * one outcome the verified layer exists to prevent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeRanking } from "../../src/laya/client.js";
import { spread } from "../../src/select.js";

const allowed = new Set([1, 2, 3]);

describe("ranking sanitiser", () => {
  it("passes a well-formed ranking through unchanged", () => {
    const { ranked, rejected } = sanitizeRanking(
      [
        { ref: 3, score: 0.9, role: "textbox", name: "Email" },
        { ref: 1, score: 0.1, role: "button", name: "Submit" },
      ],
      allowed,
    );
    assert.equal(rejected.length, 0);
    assert.deepEqual(
      ranked.map((r) => r.ref),
      [3, 1],
    );
  });

  it("sorts by score, highest first", () => {
    const { ranked } = sanitizeRanking(
      [
        { ref: 1, score: 0.2 },
        { ref: 2, score: 0.8 },
        { ref: 3, score: 0.5 },
      ],
      allowed,
    );
    assert.deepEqual(
      ranked.map((r) => r.score),
      [0.8, 0.5, 0.2],
    );
  });

  it("drops a NaN score rather than letting it read as confident", () => {
    // The bug this prevents: spread() over a NaN is NaN, every `NaN < threshold` is
    // false, so the ranking looks decided and unambiguous.
    const { ranked, rejected } = sanitizeRanking([{ ref: 1, score: Number.NaN }], allowed);
    assert.equal(ranked.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /not a finite number/);
    assert.equal(spread(ranked), 0, "an empty ranking is flat, which is the safe direction");
  });

  it("drops Infinity and other non-finite scores", () => {
    const { ranked, rejected } = sanitizeRanking(
      [
        { ref: 1, score: Number.POSITIVE_INFINITY },
        { ref: 2, score: Number.NEGATIVE_INFINITY },
      ],
      allowed,
    );
    assert.equal(ranked.length, 0);
    assert.equal(rejected.length, 2);
  });

  it("drops a non-numeric score", () => {
    for (const score of ["0.9", null, undefined, {}, []]) {
      const { ranked, rejected } = sanitizeRanking([{ ref: 1, score }], allowed);
      assert.equal(ranked.length, 0, `score ${JSON.stringify(score)} should be rejected`);
      assert.equal(rejected.length, 1);
    }
  });

  it("clamps an out-of-range score instead of rejecting it", () => {
    // A score of 1.4 is still a ranking, just badly scaled. Clamping keeps the order
    // usable where rejecting would throw away a real signal.
    const { ranked, rejected } = sanitizeRanking(
      [
        { ref: 1, score: 1.4 },
        { ref: 2, score: -0.3 },
      ],
      allowed,
    );
    assert.equal(rejected.length, 0);
    assert.equal(ranked[0]!.score, 1);
    assert.equal(ranked[1]!.score, 0);
  });

  it("drops a ref that was never offered", () => {
    // Guards against acting on a ref from a previous snapshot, or one the bridge
    // invented. A stale ref would resolve to a different element or to nothing.
    const { ranked, rejected } = sanitizeRanking([{ ref: 99, score: 0.9 }], allowed);
    assert.equal(ranked.length, 0);
    assert.match(rejected[0]!.reason, /not among the candidates offered/);
  });

  it("drops a duplicate ref so alternatives cannot repeat an element", () => {
    const { ranked, rejected } = sanitizeRanking(
      [
        { ref: 2, score: 0.9 },
        { ref: 2, score: 0.4 },
      ],
      allowed,
    );
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.score, 0.9, "the higher score should win");
    assert.match(rejected[0]!.reason, /more than once/);
  });

  it("drops a non-integer ref", () => {
    for (const ref of [1.5, "1", null, undefined, Number.NaN]) {
      const { ranked } = sanitizeRanking([{ ref, score: 0.5 }], allowed);
      assert.equal(ranked.length, 0, `ref ${JSON.stringify(ref)} should be rejected`);
    }
  });

  it("survives a completely malformed response", () => {
    for (const raw of [null, undefined, 42, "ranking", { ranked: [] }, true]) {
      const { ranked, rejected } = sanitizeRanking(raw, allowed);
      assert.deepEqual(ranked, [], `raw ${JSON.stringify(raw)} should yield nothing`);
      assert.ok(Array.isArray(rejected));
    }
  });

  it("survives non-object entries inside an array", () => {
    const { ranked, rejected } = sanitizeRanking([null, 3, "x", { ref: 2, score: 0.5 }], allowed);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.ref, 2);
    assert.equal(rejected.length, 3);
  });

  it("normalises missing name and role to null rather than undefined", () => {
    // The dashboard renders them straight into the DOM, and `undefined` would render
    // as the string "undefined" in a table cell.
    const { ranked } = sanitizeRanking([{ ref: 1, score: 0.5 }], allowed);
    assert.equal(ranked[0]!.name, null);
    assert.equal(ranked[0]!.role, null);
  });

  it("preserves a name and role that are strings", () => {
    const { ranked } = sanitizeRanking([{ ref: 1, score: 0.5, name: "Email", role: "textbox" }], allowed);
    assert.equal(ranked[0]!.name, "Email");
    assert.equal(ranked[0]!.role, "textbox");
  });

  it("rejects a non-string name rather than rendering an object", () => {
    const { ranked } = sanitizeRanking([{ ref: 1, score: 0.5, name: { a: 1 }, role: 7 }], allowed);
    assert.equal(ranked[0]!.name, null);
    assert.equal(ranked[0]!.role, null);
  });

  it("a flat ranking stays flat after sanitising", () => {
    // Equal scores must remain equal, so the caller's flat-distribution guard fires.
    const { ranked } = sanitizeRanking(
      [
        { ref: 1, score: 0.4 },
        { ref: 2, score: 0.4 },
        { ref: 3, score: 0.4 },
      ],
      allowed,
    );
    assert.equal(spread(ranked), 0);
  });
});
