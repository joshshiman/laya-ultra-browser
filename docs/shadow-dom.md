# Shadow DOM, and why writes need verifying

The short version: reading across shadow boundaries is largely solved, and writing
across them is not. This project is about the second half.

## The shape of the problem

A modern web component renders its interface inside a shadow root:

```html
<app-text-field>          <- what the light DOM contains
  #shadow-root (open)
    <input id="real-field">   <- what the user actually sees and types into
```

Two consequences, and they are very different in difficulty.

### CSS cannot cross the boundary

```js
document.getElementById("real-field")   // null
document.querySelector("#real-field")   // null
```

Not a bug, and not fixable from page script. Shadow roots are a visibility boundary.
Selectors that worked before components do not work now, and on a component-heavy
application most of the interface is behind one.

### The accessibility tree ignores the boundary

The browser computes the accessibility tree itself, below the JavaScript security
boundary. Shadow root mode is a page-script concept; the a11y tree does not care. It
reads inside **closed** roots too, which page script cannot do by any means, and it
addresses cross-origin frames as separate protocol targets.

This is why a hand-written DOM walker is not a substitute for a snapshot built on the
a11y tree, no matter how good the walker is. Measured against the same fixture:

| Control | Where it lives | DOM walker | a11y-tree snapshot |
|---|---|---|---|
| Plain button | light DOM | yes | yes |
| Button in an open root, depth 1 | open shadow | yes | yes |
| Button in open roots, depth 3 | open shadow | yes | yes |
| Button in a **closed** root | closed shadow | **no** | yes |
| Input in a cross-origin frame | frame | **no** | yes |

A census of one large single-page application found 180 custom elements, **all** with
open roots, nested up to **8 deep**, with 86% of visible controls behind a boundary.
That is not an edge case; that is most of the application.

## The part that is genuinely hard: silent write failures

Reads and clicks behave. Writes are where it breaks.

On that application, a text field that was uniquely identified, visible, in viewport,
enabled, writable, and matched exactly once:

| Action | Reported | Actually happened |
|---|---|---|
| `fill` by CSS selector | Element not found | correct, CSS cannot cross |
| `fill` by role and accessible name | **success** | **value stayed empty** |
| `type`, then again after scrolling into view | **success** | **value stayed empty** |
| `eval`: focus, assign, dispatch | success | **persisted, node still focused** |

The `eval` write is the control case and it is unambiguous: the same node object, still
connected, value retained on a second read in a later call, focus retained. Every
in-page write mechanism works. The fault is in the tool's write path.

Ruled out along the way: shadow traversal, offscreen rendering, framework re-render
discarding the value, disabled or readonly state, duplicate matches, and id churn.
Directly tested too: writing to the component's host property **does** propagate to
the inner input, so "it wrote to the wrapper" was not the explanation either.

## What this project does about it

`src/snapshot/actions.js`, in order:

1. **Resolve** through open shadow roots by ref, accessible name, role or CSS.
2. **Descend** from a component host to the real focusable control inside it. Writing
   to the host sets a property nothing displays.
3. **Precheck.** Refuse if the target cannot take a value, or is disabled or readonly.
4. **Focus**, after scrolling into view.
5. **Write through the native prototype `value` setter.** Frameworks often shadow the
   accessor, so plain assignment can run framework code that never touches the real
   input. Calling the prototype setter directly is what test utilities do.
6. **Dispatch `input` and `change` with `composed: true`.** Without `composed`, an event
   dispatched inside a shadow root never reaches a listener on the host.
7. **Read the value back off the inner control** and compare.
8. **Report `verified`**, and on failure say what happened.

### Three failure shapes, reported separately

They need different fixes, so they are not collapsed into one error:

**Target not found** — `stage: "resolve"`.

**Target cannot take a value** — `stage: "precheck"`. The important case here is a
write aimed at a `<button>`. Assigning `.value` creates a plain expando property: the
value persists, the read-back matches, and an unguarded layer reports a cheerful
success for a write that changed nothing a user can see. This is the one failure mode
verification cannot catch, which is why the check exists. The refusal lists the text
fields that were actually available.

**Landed but did not persist** — `stage: "verify"`, with a distinct
`hostEchoedValue` flag. Some wrappers store an assigned value and echo it back, which
defeats naive verification: the host agrees with you while the real control never
changed. The layer verifies against the inner node specifically, and reports the echo
case rather than passing it.

## Two rules that generalise

1. **Never trust a write's success report on a component application. Read the value
   back.** Every mature browser automation tool surveyed built post-action verification
   independently. That is why.
2. **`composed: true` matters** on any event dispatched inside a shadow root, or
   listeners on the host never see it.

## The occlusion gap

One more thing the accessibility tree does not model: **paint order**. A snapshot will
list a control four thousand pixels below the fold, or one under a full-viewport
overlay, with no hint that either is unreachable. You cannot click what you cannot see.

`walker.js` hit-tests through shadow boundaries, rooted at each element's own document
— an element inside a frame reports coordinates in that frame's space, and testing them
against the top document returns nondeterministic garbage. `browser_snapshot` reports
`clear`, `offscreen` or `covered` per element.

This is genuinely additive to an a11y-tree snapshot, and it is the part of the walker
that earns its place.

## The conformance fixture

`test/fixtures/shadow-lab.html` is a self-checking page, 72 assertions, that
characterises what a browser tool can see and write:

- light DOM baseline
- one open shadow root, and three nested
- a closed root, which must be reported unreachable
- `srcdoc` and `src=` iframes
- hidden, offscreen and covered controls
- a wrapper that echoes host writes
- an input with a framework-shadowed value setter
- disabled and readonly fields

`npm test` runs it in real Chromium through the same injection path a user hits, so the
documented pass counts cannot drift from reality.

It is also useful against other tools. Point any browser automation tool at it and the
result tells you what that tool can actually see and write, which is faster than
inferring it from a failing task.

> One caveat: under `file://`, Chrome gives file documents opaque origins, so the
> `src=` iframe case is expected to fail. The `srcdoc` frame exercises the same code
> path and does pass. Serve over HTTP to see both.

## What is genuinely unreachable

- **Closed shadow roots**, from page script. A platform boundary. `browser_snapshot`
  counts suspected ones so you know when coverage is incomplete.
- **Cross-origin frames**, which need separate protocol targets. Count and URLs are
  reported.
