# laya-ultra-browser

Status: **paused after the Phase 0 spike, by design.** Read [`docs/phase-0-spike-result.md`](docs/phase-0-spike-result.md) first.

## What this was going to be

A local MCP server, drop-in compatible with agent-browser's 29 tools, that pierced shadow DOM (which no Jev-based browser harness does) and used a local Laya decision model for typed questions about page content. The full design is in `docs/laya-browser-mcp-design.md`.

## Why it stopped

The spike disproved the premise. agent-browser's snapshot is the browser's own accessibility tree over CDP, not a DOM walk, so it already reads inside shadow roots, including **closed** ones, and into cross-origin frames. It is strictly better than anything page script can do.

The real ISC problem appears to be that CSS selectors cannot cross shadow boundaries while snapshot refs can. That is a workflow fix, not a tooling gap:

```
snapshot interactive:true   ->  find the control by role + accessible name
click selector:"e42"        ->  works, even inside a closed shadow root
click selector:"#my-field"  ->  Element not found
```

## What's here and still useful

| Path | What it is |
|---|---|
| `src/snapshot/walker.js` | Shadow-piercing DOM walker. 30/30 on the fixture. Obsolete for coverage, but a working **occlusion oracle**: it reports covered and offscreen controls, which the a11y tree does not model. Injectable through agent-browser's `eval`. |
| `scripts/out/walker.min.js` | Comment-stripped build of the above, for injection. |
| `test/fixtures/shadow-lab.html` | Self-checking shadow DOM conformance fixture: light DOM, open roots to depth 3, a closed root, `src=` and `srcdoc` frames, hidden, offscreen, and covered controls. Run it against any browser tool to characterize what that tool can actually see. |
| `docs/phase-0-spike-result.md` | The findings, the evidence, and the three-step check to run against ISC. |
| `docs/laya-browser-mcp-design.md` | The original design and build plan, kept for the parity map and the Laya research. |

## Running the fixture

```bash
npm run build:walker          # regenerate scripts/out/walker.min.js
# then open test/fixtures/shadow-lab.html in a browser and run:
#   window.__layaLab.run()
# -> { passed: 30, total: 30, failures: [] }
```

The fixture loads the walker with a plain `<script src>`, so no injection is needed and `file://` works. Note that the `src=` iframe case is expected to fail under `file://` because Chrome gives file documents opaque origins; the `srcdoc` frame exercises the same code path and does pass.

## If this gets picked up again

In priority order, and all of it much smaller than the original plan:

1. **Confirm the ISC fix.** Run the three-step check in the spike doc. If snapshot refs reach the fields, close this repo.
2. **`browser_await_auth`.** The one genuine gap: a tool that blocks mid-flow on a URL, text, or predicate check while you complete SSO and MFA, then continues. agent-browser only has this as session-start parameters.
3. **Occlusion overlay.** Wrap `walker.js` as a thin diagnostic that annotates which snapshot refs are actually clickable right now.
4. **`laya-mcp`.** Independent of all the above. Install `wsargent/laya-mcp` for local batched typed decisions. Mind the defaults: it loads the 512-token-context English checkpoint, and its daemon timeout is 15s.

## License

MIT.
