# Phase 0 spike result: stop, the premise was wrong

Run 2026-09-21. Verdict: **do not build the 29-tool parity layer.** The shadow DOM problem that justified this project does not exist in agent-browser, and the ISC failure it was meant to fix is almost certainly a usage error with a zero-code fix.

## What the spike was supposed to answer

Whether a page-script DOM walker could pierce shadow roots well enough to reach controls on ISC's Lightning UI, on the assumption (from surveying the Jev harness ecosystem) that shadow DOM was the blocker and that no existing tool could cross it.

## What was built

`src/snapshot/walker.js`, a recursive walker that descends open shadow roots and same-origin iframes, computes accessible names, hit-tests occlusion through shadow boundaries, and maintains a ref registry. Plus `test/fixtures/shadow-lab.html`, a self-checking fixture with known-answer cases: light DOM, one open shadow root, three nested open roots, a closed root, a `src=` iframe, a `srcdoc` iframe, hidden, offscreen, and deliberately covered controls.

The walker works. 30 of 30 assertions pass. On `shoelace.style/components/select` it traversed 546 open shadow roots to depth 4 across 7,829 elements in 2 to 3 ms, and found 262 interactive controls against a flat walk's 219, a real gain of 43 including `input[role=combobox]` controls.

One genuine bug was found and fixed along the way: elements inside an iframe report `getBoundingClientRect` in that frame's coordinate space, and I was hit-testing those coordinates against the top document. In-frame occlusion results flapped between runs. Fixed by resolving each element's own `ownerDocument.defaultView` before measuring, and a determinism assertion now guards it.

## The finding that killed the project

Then I ran agent-browser's own `snapshot` against the same fixture. It found everything:

| Control | Where it lives | My walker | agent-browser |
|---|---|---|---|
| `LIGHT_BUTTON` | light DOM | yes | yes |
| `SHADOW_1_BUTTON` | open shadow root, depth 1 | yes | yes |
| `SHADOW_3_BUTTON` | open shadow roots, depth 3 | yes | yes |
| `CLOSED_BUTTON` | **closed** shadow root | **no** | **yes** |
| `SRCDOC_BUTTON` | srcdoc iframe | yes | yes |
| `FRAME_BUTTON` | `src=` iframe, opaque file origin | **no** | **yes** |

agent-browser is strictly better. It sees inside closed shadow roots, which is impossible from page script by design, and into frames my walker is forbidden to read.

The reason is architectural. agent-browser's snapshot is not a DOM walk. It's the browser's own accessibility tree over CDP, computed inside Chrome below the JavaScript security boundary. Shadow root mode is a JS-visibility concept; the a11y tree does not care. Cross-origin frames are separate CDP targets the protocol can address directly.

Then the decisive test, clicking a control inside an open shadow root two ways:

```
click selector="e6"          -> success   (ref from the snapshot)
click selector="#s1-button"  -> Element not found
```

And for completeness, both of these succeeded:

```
click  selector="e18"   -> success   (button inside a CLOSED shadow root)
fill   selector="e22"   -> success   (input inside a frame page script cannot read)
```

## What this means for ISC

The recorded belief was "MCP selectors can't pierce shadow DOM." That is half right in a way that matters enormously: **CSS selectors can't cross shadow boundaries, refs can.** `document.querySelector('#s1-button')` genuinely cannot find a node inside a shadow root, and never will. But `snapshot` already returns a ref for that exact node, and passing the ref to `click` or `fill` works.

So the likely fix for ISC is not a new tool. It is:

1. `agent_browser_snapshot` with `interactive: true`
2. find the control by its role and accessible name in the returned tree
3. pass its `ref` (e.g. `e42`) to `click` / `fill` / `select`, never a CSS selector

Caveat I cannot close from here: I have no VPN or w3id session, so this was proven on a synthetic fixture and a public web-components site, not on ISC itself. The mechanism is origin- and shadow-mode-agnostic, so it should hold, but it needs one confirmation run.

### The three-step check to run on ISC

Open an ISC opportunity page, authenticate as normal, then:

1. `snapshot` with `interactive: true`, and look for the fields you previously could not reach.
2. If they appear, `click` one by its ref. If that works, the project is unnecessary and the workflow change is the whole fix.
3. If they do **not** appear in the snapshot, that is a different and more interesting failure, and worth reporting back. Likely candidates then are lazy rendering (the control genuinely isn't in the tree until scrolled or expanded) or a virtualized grid, neither of which a DOM walker would fix either.

## What survives

Three things, all much smaller than the original plan.

**The auth hold is still a real gap.** agent-browser has `restore` plus `restoreCheckUrl` / `restoreCheckText` / `restoreCheckFn`, but only as session-start parameters. There is no tool that blocks mid-flow while you complete SSO and MFA and then continues. That remains worth having and is a small piece of work.

**Occlusion reporting is a real gap.** agent-browser's snapshot listed `OFFSCREEN_BUTTON` and `COVERED_BUTTON` with no indication that one is 4,000px down the page and the other sits under a full-viewport overlay. The a11y tree does not model paint order. `walker.js` does, correctly, through shadow boundaries, and it is proven by test. That is genuinely additive information and it can be injected through agent-browser's existing `eval` tool with no new MCP server at all.

**Laya is unaffected.** None of this touched the `page_ask` idea. `wsargent/laya-mcp` still installs in an afternoon and still gives batched typed questions over page content at no marginal cost, fully local. That was always the independently valuable half, and it does not depend on any of the above.

## Cost of the spike

About an hour. Which is the point of spiking first: the alternative was two to four weeks building a parity layer to solve a problem that was already solved, and shipping something with worse coverage than the tool it replaced.

## Reusable artifacts

- `src/snapshot/walker.js` plus `scripts/out/walker.min.js`, injectable, 30/30 on the fixture, useful as an occlusion oracle
- `test/fixtures/shadow-lab.html`, a self-checking shadow DOM conformance fixture. Worth keeping regardless: it is a fast way to characterize what any future browser tool can and cannot see.
