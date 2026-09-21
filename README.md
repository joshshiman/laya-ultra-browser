# laya-ultra-browser

Status: **narrowed, not dead.** Read [`docs/isc-live-findings.md`](docs/isc-live-findings.md) first, then [`docs/phase-0-spike-result.md`](docs/phase-0-spike-result.md) for how we got there.

**The one-line version:** on ISC Lightning, 86% of controls sit behind native open shadow roots nested up to 8 deep. agent-browser *reads* them all correctly. But `fill` and `type` report `success` and silently write nothing, while `eval` writing the same node persists. The bug is the write path, not shadow traversal.

## What this was going to be

A local MCP server, drop-in compatible with agent-browser's 29 tools, that pierced shadow DOM (which no Jev-based browser harness does) and used a local Laya decision model for typed questions about page content. The full design is in `docs/laya-browser-mcp-design.md`.

## Why it narrowed

The spike disproved the original premise. agent-browser's snapshot is the browser's own accessibility tree over CDP, not a DOM walk, so it already reads inside shadow roots, including **closed** ones, and into cross-origin frames. It is strictly better than anything page script can do, so building a walker for coverage is pointless.

Reads and selectors behave as you'd expect:

```
snapshot interactive:true                          ->  sees all 189 ISC controls
click selector:"e42"                               ->  works, even inside a closed shadow root
click selector:'role=searchbox[name="Search..."]'  ->  resolves through shadow roots
click selector:"#my-field"                         ->  Element not found (CSS can't cross)
```

Then live ISC testing found the actual problem: **writes silently fail.**

```
fill  selector:'role=searchbox[name="Search this feed..."]'  ->  "success", value stays empty
type  same selector, scrolled into view                      ->  "success", value stays empty
eval  focus() + value= + InputEvent                          ->  persists correctly
```

Ruled out: shadow traversal, offscreen/virtualization, LWC re-render, disabled/readonly, duplicate matches, id churn, and (tested directly) host-versus-inner, since writing `lightning-input.value` on the host *does* propagate to the inner input. Every in-page write mechanism works. The fault is in agent-browser's write path; the mechanism inside it is unknown without reading its source.

**The fix is built and validated on live ISC.** `src/snapshot/actions.js` resolves through shadow roots, descends host to inner node, writes via the native prototype setter, fires `composed: true` events, and reads the value back to confirm:

```
write:  ok true, verified true, "" -> "laya write test", setterUsed nativeSetter
recheck in a later call:  persisted
```

30/30 walker tests, 42/42 action tests, including a reproduced host-echo wrapper and a framework-shadowed value setter.

## What's here and still useful

| Path | What it is |
|---|---|
| `src/snapshot/actions.js` | **The fix.** Shadow-aware `writeText` / `clickDeep` / `selectOption` / `inspect`, each with post-action verification. Resolves by accessible name or CSS through open shadow roots, prefers the deepest native field over its wrapper, descends host to inner node, writes via the native prototype setter, fires `composed: true` events, reads back. 42/42. |
| `src/snapshot/walker.js` | Shadow-piercing DOM walker. 30/30. Obsolete for *coverage* (the a11y tree wins) but a working **occlusion oracle**: it reports covered and offscreen controls, which the a11y tree does not model. Supplies the ref map that `actions.js` can target. |
| `scripts/out/*.min.js` | Comment-stripped builds of both, for injection through `eval`. `npm run build:inject`. |
| `test/fixtures/shadow-lab.html` | Self-checking conformance fixture, 72 assertions across two entrypoints. Light DOM, open roots to depth 3, a closed root, `src=` and `srcdoc` frames, hidden, offscreen and covered controls, an LWC-like wrapper that echoes host writes, and an input with a framework-shadowed value setter. Run it against any browser tool to characterize what that tool can actually see and write. |
| `docs/phase-0-spike-result.md` | The findings, the evidence, and the three-step check to run against ISC. |
| `docs/laya-browser-mcp-design.md` | The original design and build plan, kept for the parity map and the Laya research. |

## Running the fixture

```bash
npm run build:inject     # regenerate scripts/out/{walker,actions}.min.js
# then open test/fixtures/shadow-lab.html in a browser and run:
#   window.__layaLab.run()         -> { passed: 30, total: 30, failures: [] }
#   window.__layaLab.runActions()  -> { passed: 42, total: 42, failures: [] }
```

The fixture loads the walker with a plain `<script src>`, so no injection is needed and `file://` works. Note that the `src=` iframe case is expected to fail under `file://` because Chrome gives file documents opaque origins; the `srcdoc` frame exercises the same code path and does pass.

## If this gets picked up again

In priority order. All of it is much smaller than the original 29-tool plan, and items 1 and 2 are now the whole point of the repo.

1. ~~**A shadow-aware write path.**~~ **Done.** `src/snapshot/actions.js`, validated on live ISC.
2. ~~**Post-action verification.**~~ **Done.** Every mutating call reads back and reports `verified`, plus `hostEchoedValue` for wrappers that lie.
3. **Wrap it as an MCP server.** The layer works but is currently injected by hand through `eval`. Two tools (`write_text`, `click_deep`) plus `inspect` would make it usable without pasting scripts. This is now the highest-value remaining item.
4. **Exercise `clickDeep` and `selectOption` on ISC.** Fixture-verified only. Clicks mutate real CRM state, so this needs a safe target chosen deliberately.
5. **`browser_await_auth`, as a poll loop.** Not one long block: a 200s `wait_for_selector` wedged the session so badly that every later call on it timed out. Short waits, predicate check between each, total deadline.
6. **Occlusion oracle.** `walker.js` already does this, correctly, through shadow boundaries. Better motivated now: `snapshot` happily listed the test control with no hint it was 1786px below the fold.
7. **`laya-mcp`.** Independent of all the above. Install `wsargent/laya-mcp` for local batched typed decisions. Mind the defaults: it loads the 512-token-context English checkpoint, and its daemon timeout is 15s.

Until item 3 exists, the working ISC recipe is: `snapshot` to find things, then inject `scripts/out/actions.min.js` through `eval` once per page and call `window.__laya.writeText({ariaLabel: "..."}, "value")`, which verifies for you. Details in [`docs/isc-live-findings.md`](docs/isc-live-findings.md).

## License

MIT.
