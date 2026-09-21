# Live ISC findings: the real root cause

Run 2026-09-21 against `ibmsc.lightning.force.com/lightning/page/home`, authenticated via w3id in a headed browser. This supersedes the "just use refs" conclusion in `phase-0-spike-result.md`, which was right about shadow DOM and wrong about what actually breaks.

## Summary

Reads work. Writes silently fail.

agent-browser resolves shadow-DOM elements correctly on Lightning, and reports `success` on `fill` and `type`. The value never lands. No error, no warning. `eval` writing to the same node persists perfectly.

## What Lightning actually is

Census of the live ISC home page:

| Measure | Value |
|---|---|
| Elements walked | 3,020 |
| Custom elements | 180 |
| Of which have **open** shadow roots | 180 (all of them) |
| Max shadow nesting depth | **8** |
| Suspected closed shadow roots | 0 |
| iframes (same or cross origin) | 0 |
| Visible interactive controls | 189 |
| **Controls behind a shadow boundary** | **163 (86%)** |

Component prefixes: `lightning` (85), `one` (29), `runtime_copilot_base` (18), `runtime_iag_core` (12), `c` (8), `runtime_copilot` (8), `runtime_thp_learning` (7), `force` (3), plus singles.

So Lightning uses **native** shadow DOM, all open, nested up to 8 deep, with 86% of the UI behind a boundary. That is why CSS and id selectors fail: it is not a quirk, it is most of the app.

Confirmed directly: for the test control `input#input-111`, `document.getElementById('input-111')` returns `null` while the element is connected and visible. The id was stable across the whole session, so this is not id churn.

## What works and what doesn't

Test control: the feed search input, `<input type="search" placeholder="Search this feed...">`, at shadow depth 2, host chain `lightning-primitive-input-simple < lightning-input`. Uniquely identified, one match on the page, `disabled: false`, `readOnly: false`, `tabIndex: 0`, no `aria-hidden` ancestor.

| Action | Reported | Actually happened |
|---|---|---|
| `fill selector="#input-111"` | Element not found | correct, CSS cannot cross the boundary |
| `fill selector='role=searchbox[name="Search this feed..."]'` | **success** | **value stayed empty** |
| `type` same role selector, `clear: true` | **success** | **value stayed empty** |
| `type` again after scrolling into view | **success** | **value stayed empty** |
| `click` same role selector | Element not found | flaky, resolved a minute earlier |
| `eval`: `focus()` + `value=` + `InputEvent` | success | **persisted, node still focused** |

The `eval` write is the control case, and it is unambiguous: same node object (`liveNodeIsSameObject: true`), still connected, value retained on a second read in a later call, focus retained.

## Ruled out

- **Shadow DOM traversal.** Playwright's `role=` engine pierces open shadow roots. The element resolves; `fill` returned success rather than not-found.
- **Offscreen / virtualization.** The control sat at `y: 1786` initially, well below an 792px viewport. I scrolled it to `y: 422`, confirmed in-viewport, and `type` still silently failed.
- **LWC discarding the value on re-render.** The `eval` write persisted across calls. If the framework were resetting state, it would have cleared that too.
- **Disabled, readonly, aria-hidden, or duplicate matches.** All checked, all clean, exactly one match.
- **Id churn.** `input-111` was stable across the entire session.

## Cause: symptom confirmed, mechanism still unknown

My first hypothesis was that the write lands on the shadow **host** rather than the inner input, setting a meaningless property on a custom element. **That is now falsified.** Tested directly on the live page:

```
host = the enclosing <lightning-input>
host.value = "direct host prop write"
  -> inner input#input-111 value becomes "direct host prop write"   // it propagates
```

`lightning-input.value` is a real LWC reactive public property and it works. So host-versus-inner is not the explanation here.

What is established:

- Every in-page write mechanism works: the host's public property, `el.value =`, and the native prototype setter all reach the field and persist across separate calls.
- agent-browser's `fill` and `type` report `success` and write nothing to the same field.
- Therefore the fault is in agent-browser's write path, not in Lightning's DOM, and not in anything the page does to defend itself.

The mechanism inside agent-browser is unknown without reading its source. Candidates worth checking: it resolves an a11y-tree node that does not map back to the real input; it dispatches synthetic events the framework ignores; or it acts on coordinates that land on a wrapper. I am deliberately not guessing further, because I already guessed wrong once here.

The host-echo hazard is real for *some* component libraries, where a wrapper stores an assigned value and echoes it back so that naive read-back verification also passes. `actions.js` detects and reports that case (`hostEchoedValue`), and it is regression-tested in the fixture. It just isn't what Lightning does.

## The fix, built and validated live

`src/snapshot/actions.js` implements the write path. Validated on the live ISC page against the exact field that `fill` and `type` silently failed on:

```
preflight: matched input#input-111, type=search, shadowDepth 2,
           hostChain "lightning-primitive-input-simple < lightning-input",
           1 name match, no ambiguity

write:     ok true, verified true, stage "done"
           valueBefore ""  ->  valueAfter "laya write test"
           setterUsed "nativeSetter", eventsFired [input, change], focused true

recheck in a later call:  persistedAcrossCalls true
descent from lightning-input host:  resolves to input#input-111
```

What the layer does, in order: resolve through open shadow roots by accessible name or CSS, prefer the deepest native field over the wrapper, descend from a component host to the inner focusable node, `scrollIntoView`, `focus({preventScroll:true})`, write via the native prototype `value` setter, dispatch `input` and `change` with `composed: true`, then **read the value back off the inner node and report whether it took**.

Test coverage: 30/30 on the walker fixture, 42/42 on the action fixture, including a deliberately reproduced host-echo wrapper, a framework-shadowed value setter, refusals on disabled and readonly fields, stale-ref detection, and a check that `composed: true` events actually cross the shadow boundary.

Caveat on the live run: the injected script was the write path transcribed from `actions.js`, not the full built file, because injection happens through a string parameter. The functions exercised (`resolveDeep`, `innerFocusable`, `nativeValueSetter`, `setValue`, `fireInputEvents`, `writeText`) are the same implementations that the fixture tests cover. `clickDeep`, `selectOption` and `inspect` are fixture-verified only, not yet exercised on ISC.

## The practical workaround, today

For reads and navigation on Lightning, agent-browser is fine. `snapshot` sees all 189 controls including the 163 behind shadow boundaries.

For writes on Lightning, use `eval` and verify:

```js
// resolve through shadow roots by a stable attribute, then write and verify
(function(){
  var q=[{r:document}], hit=null, guard=0;
  while(q.length && guard<9000 && !hit){
    var j=q.shift(); guard++;
    var all; try{ all=j.r.querySelectorAll('*'); }catch(e){ continue; }
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if(el.shadowRoot) q.push({r:el.shadowRoot});
      if(el.tagName==='INPUT' && el.getAttribute('aria-label')==='YOUR FIELD LABEL'){ hit=el; break; }
    }
  }
  if(!hit) return JSON.stringify({ok:false, reason:'not found'});
  hit.scrollIntoView({block:'center'});
  hit.focus();
  hit.value = 'YOUR VALUE';
  hit.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
  hit.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
  return JSON.stringify({ok: hit.value==='YOUR VALUE', value: hit.value});  // verify in the same call
})()
```

Two rules that follow from this and generalise beyond Lightning:

1. **Never trust a write's success report on a shadow-DOM SPA.** Read the value back. Every Jev harness surveyed independently built post-action verification; this is why.
2. **`composed: true` matters** on events dispatched inside a shadow root, or listeners on the host never see them.

## What this does to the project

The spike said stop. This partially reverses that, for a narrower and better-evidenced reason.

Not worth building: the 29-tool parity layer, and any page-script shadow walker for *coverage*. agent-browser's a11y tree beats it, including closed roots.

Now clearly worth building, and small:

1. **A write path that resolves to the inner focusable node inside the shadow tree**, not the host. This is the actual bug, it affects 86% of ISC's controls, and it is perhaps 100 lines.
2. **Post-action verification.** Read back and compare; return a real failure when the write did not take. Fixes the silent-success class of bug outright.
3. **The occlusion oracle** (`walker.js`) is still useful and now better motivated: `snapshot` listed this control with no hint it was 1786px below the fold.
4. **The auth hold**, with a caveat learned the hard way below.

## Auth hold: the failure mode

A single `wait_for_selector` with `waitTimeoutMs: 200000` did not hold the session, it **wedged** it. That call timed out, and every subsequent call on that session (including `get_url`) also timed out until the session was re-opened with `open`.

So the auth hold must not be one long block. It should be a poll loop of short waits, checking a predicate between each, with a total deadline. That is a design constraint for `browser_await_auth`, and it needs to live on whichever side owns the browser.

Practical note that worked: re-issuing `open` with the same `session` and `restore` key recovered cleanly and landed already-authenticated, because the login had completed in the headed window in the meantime.
