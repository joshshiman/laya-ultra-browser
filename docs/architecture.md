# Architecture

Four layers. The rule that shapes all of them: **Laya proposes, the deterministic layer
disposes and verifies.** The model never touches the page and never decides that an
action succeeded.

```
MCP client
    │  stdio, JSON-RPC
    ▼
┌─────────────────────────────────────────────────────────────┐
│ server.ts        tool surface, target building, reporting   │
├─────────────────────────────────────────────────────────────┤
│ select.ts        goal -> a ref, via Laya or deterministically│
├───────────────────────────┬─────────────────────────────────┤
│ laya/client.ts            │ page.ts   typed access to        │
│ persistent Python bridge  │           window.__laya          │
│ NDJSON over stdin/stdout  ├─────────────────────────────────┤
│                           │ inject.ts  install the layer     │
│                           │ browser.ts Chromium lifecycle    │
└───────────────────────────┴─────────────────────────────────┘
                                    │
                    page.evaluate   │   reads dist/snapshot/*.js
                                    ▼
                    ┌───────────────────────────────┐
                    │ in the page                   │
                    │  walker.js   snapshot, refs   │
                    │  actions.js  write, verify    │
                    └───────────────────────────────┘
```

## The in-page layer

`src/snapshot/walker.js` and `src/snapshot/actions.js` are plain ES5-compatible
JavaScript IIFEs that install `window.__laya`. They have no imports and no build step,
because they have to be injectable verbatim into an arbitrary page — through
`Runtime.evaluate`, a Playwright `page.evaluate`, or a paste into a console.

That constraint is the reason they are not TypeScript. Everything above them is.

**walker.js** walks the document plus every open shadow root and same-origin frame,
computes a pragmatic accessible name, hit-tests occlusion through shadow boundaries,
and keeps a registry mapping stable refs to live nodes. Refs fail closed: re-injection
bumps a generation counter, and a ref from a previous generation stops resolving rather
than silently pointing at a different node.

**actions.js** performs writes, clicks and selections, and verifies each one.

Both are covered by `test/fixtures/shadow-lab.html`, a self-checking conformance
fixture: light DOM, open roots nested three deep, a closed root, `srcdoc` and `src=`
frames, hidden, offscreen and covered controls, a wrapper that echoes host writes, and
an input with a framework-shadowed value setter. 72 assertions, run in real Chromium
by `npm test`.

## Injection

`inject.ts` reads both files as source text and installs them with
`context.addInitScript`, guarded to the top frame. Init scripts rather than a one-shot
`evaluate`, because a single navigation would otherwise silently drop the layer and
every later call would fail with an undefined `window.__laya` — a failure that looks
like a tool bug rather than a missing install.

The install path verifies that `window.__laya.snapshot` and `window.__laya.writeText`
exist afterwards, rather than trusting the absence of an exception.

## Target resolution

`select.ts` turns a goal into a ref:

1. **Explicit ref** — returned untouched, no snapshot, no model call.
2. **Laya ranking** — snapshot the page, pre-filter the candidates lexically, send the
   shortlist to the local model, take the argmax.
3. **Deterministic fallback** — token overlap on accessible names plus a role hint.

The fallback is not a consolation prize. When the model is absent or slow, it is the
only thing standing between a goal and a click on the wrong control, so it is a pure
exported function with its own tests.

## The Laya bridge

`laya/client.ts` spawns `bridge.py` once and keeps it warm. A subprocess rather than a
per-call invocation because loading the model costs about 0.4s warm and roughly 19s
cold, and the first load pulls around 2GB of weights.

The bridge is strictly optional. `layaStatus()` probes for an interpreter that can
import the runtime, caches the answer, and every other tool works regardless. The
bridge is a long-lived child speaking newline-delimited JSON; `stdout` carries protocol
frames only, with library output redirected to `stderr` so a progress bar cannot
corrupt the stream.

### Why the model only ranks

Two hard limits, both enforced rather than documented-and-hoped:

- **The option head has a fixed token budget** (192 for the English checkpoint, 256
  for the others). Past roughly 20 options accuracy collapses, and the runtime raises
  rather than truncating. So candidates are pre-filtered to a shortlist first.
- **Scores are not calibrated.** The checkpoint ships temperatures the runtime has to
  clamp, and warns that the affected buckets should be treated as uncalibrated. The
  API therefore never returns a field named `confidence`, only `score`, and the
  dashboard says so on every screen.

## Verification

The load-bearing idea. A write is not done when it is dispatched; it is done when the
value is read back off the real inner control and matches.

Three distinct failure shapes are reported separately, because they need different
fixes:

| Shape | Reported as |
|---|---|
| Target not found | `stage: "resolve"` |
| Target cannot take a value (a button, a disabled field) | `stage: "precheck"`, with the real text fields listed |
| Write landed but did not persist, or a wrapper echoed it | `stage: "verify"`, `hostEchoedValue: true` |

The precheck exists because of the one case verification cannot catch: assigning
`.value` to a `<button>` creates a plain expando, the read-back matches, and an
unguarded layer cheerfully reports success. Custom elements are exempt from the
precheck, because a wrapper is neither a field nor a definitive non-field — the
descend-and-compare logic gives a more precise diagnosis for those.

## Process hygiene

- **stdout belongs to the protocol.** Every diagnostic goes to `stderr`. One stray
  `console.log` corrupts the stream and the client disconnects with a parse error that
  points nowhere near the cause.
- **The browser is lazy.** Starting the server does not launch Chromium.
- **Idle releases, it does not close.** After the idle timeout the next call relaunches.
  Terminal shutdown is separate, and only that is terminal.
- **Signals clean up.** `SIGINT`, `SIGTERM` and a closed stdin pipe all take the browser
  and the bridge down. An orphaned Chromium is the classic MCP server bug.
- **Config fails fast.** A malformed environment variable throws at startup with a
  message naming the variable, rather than becoming a confusing error mid-task.

## The visualizer

`visualizer/` is a small loopback HTTP server: one HTML page, one SSE stream, one JSON
snapshot endpoint. Off by default, and a failure to bind is logged and swallowed
because observability must never be the reason a task fails.

Events go through a bounded ring buffer, and a subscriber that throws is caught: a
broken dashboard cannot fail the tool call that produced the event.
