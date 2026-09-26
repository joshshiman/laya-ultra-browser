/**
 * laya-ultra-browser: shadow-aware action layer with post-action verification.
 *
 * Solves the bug found on ISC Lightning 2026-09-21: a write resolves the element,
 * reports success, and silently does nothing. Two causes, both handled here.
 *
 *   1. HOST vs INNER NODE. A `lightning-input` is a custom element wrapping a real
 *      <input> inside its shadow root. Assigning `.value` on the host sets a
 *      meaningless expando and changes nothing visible. We descend to the inner
 *      focusable node before writing.
 *
 *   2. SHADOWED VALUE SETTER. Frameworks often define their own `value` accessor
 *      on the element (or its class), so `el.value = x` runs framework code that
 *      may not touch the real input. We call the native prototype setter directly,
 *      which is what React/Vue/LWC test utilities do.
 *
 * Every mutating call reads the result back and reports `verified`. A write that
 * did not take returns ok:false rather than a cheerful success.
 *
 * Plain JS, no imports, no build step. Injected verbatim. Works standalone; if
 * walker.js is already present it reuses its ref map.
 */
(function () {
  "use strict";

  var NATIVE_FIELD = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };
  var MAX_NODES = 12000;

  // ---------------------------------------------------------------------------
  // Deep traversal
  // ---------------------------------------------------------------------------

  /** Walk document + all open shadow roots + same-origin frames, calling fn(el, depth). */
  function walkDeep(fn, startRoot) {
    var queue = [{ root: startRoot || document, depth: 0 }];
    var seen = 0;
    while (queue.length) {
      var job = queue.shift();
      var all;
      try { all = job.root.querySelectorAll("*"); } catch (e) { continue; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (++seen > MAX_NODES) return;
        if (el.shadowRoot) queue.push({ root: el.shadowRoot, depth: job.depth + 1 });
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          var doc = null;
          try { doc = el.contentDocument; } catch (e) { doc = null; }
          if (doc && doc.querySelectorAll) queue.push({ root: doc, depth: job.depth });
        }
        if (fn(el, job.depth) === false) return;
      }
    }
  }

  function isRenderedish(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      var win = (el.ownerDocument || document).defaultView || window;
      var s = win.getComputedStyle(el);
      return !!s && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Target matching
  // ---------------------------------------------------------------------------

  function accName(el) {
    return (el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || el.getAttribute("title")
      || (el.textContent || "").replace(/\s+/g, " ").trim()
      || "").slice(0, 200);
  }

  function norm(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * target may be:
   *   { ref: 7 }                         a ref from walker.js's last snapshot
   *   { ariaLabel: "Search this feed..." }
   *   { placeholder: "..." }
   *   { name: "...", role: "textbox" }   accessible-name match, role optional
   *   { css: "#id" }                     plain CSS, evaluated deeply per root
   *   { exact: false }                   substring instead of equality (default false)
   */
  function resolveDeep(target) {
    if (!target) return { el: null, reason: "no target given" };

    if (target.ref != null && window.__laya && typeof window.__laya.resolve === "function") {
      var byRef = window.__laya.resolve(target.ref);
      if (byRef) return { el: byRef, reason: null, matchedBy: "ref" };
      return { el: null, reason: "ref " + target.ref + " did not resolve, snapshot is stale" };
    }

    var wantAria = target.ariaLabel != null ? norm(target.ariaLabel) : null;
    var wantPlaceholder = target.placeholder != null ? norm(target.placeholder) : null;
    var wantName = target.name != null ? norm(target.name) : null;
    var wantRole = target.role != null ? norm(target.role) : null;
    var exact = target.exact !== false;
    var matches = [];

    function cmp(actual, wanted) {
      if (wanted == null) return true;
      var a = norm(actual);
      return exact ? a === wanted : a.indexOf(wanted) !== -1;
    }

    walkDeep(function (el, depth) {
      if (target.css) {
        var hit = false;
        try { hit = el.matches(target.css); } catch (e) { hit = false; }
        if (hit) matches.push({ el: el, depth: depth });
        return;
      }
      if (wantAria != null && !cmp(el.getAttribute("aria-label"), wantAria)) return;
      if (wantPlaceholder != null && !cmp(el.getAttribute("placeholder"), wantPlaceholder)) return;
      if (wantName != null && !cmp(accName(el), wantName)) return;
      if (wantRole != null) {
        var r = norm(el.getAttribute("role"));
        if (!r && el.tagName === "INPUT") {
          var t = norm(el.getAttribute("type") || "text");
          r = t === "search" ? "searchbox" : (t === "checkbox" || t === "radio" ? t : "textbox");
        }
        if (!r && el.tagName === "TEXTAREA") r = "textbox";
        if (!r && el.tagName === "BUTTON") r = "button";
        if (!r && el.tagName === "A") r = "link";
        if (r !== wantRole) return;
      }
      if (wantAria == null && wantPlaceholder == null && wantName == null && wantRole == null) return;
      matches.push({ el: el, depth: depth });
    });

    var visible = matches.filter(function (m) { return isRenderedish(m.el); });
    var pool = visible.length ? visible : matches;

    if (!pool.length) return { el: null, reason: "no element matched target", candidates: 0 };
    if (pool.length > 1 && target.index == null) {
      // Prefer the deepest match: on a component library the inner native node is
      // what you want, and the host usually also matches on aria-label.
      pool.sort(function (a, b) { return b.depth - a.depth; });
      var nativeFirst = pool.filter(function (m) { return NATIVE_FIELD[m.el.tagName]; });
      if (nativeFirst.length) pool = nativeFirst;
    }
    var chosen = pool[target.index != null ? target.index : 0];
    if (!chosen) return { el: null, reason: "index " + target.index + " out of range of " + pool.length };
    return {
      el: chosen.el,
      reason: null,
      matchedBy: target.css ? "css" : "name",
      depth: chosen.depth,
      ambiguous: pool.length > 1,
      candidates: pool.length
    };
  }

  /**
   * Descend from a custom-element host to the real focusable node inside it.
   * This is the core fix: `lightning-input` -> its shadow <input>.
   */
  function innerFocusable(el) {
    if (!el) return null;
    if (NATIVE_FIELD[el.tagName] || el.isContentEditable) return el;
    var found = null;
    walkDeep(function (candidate) {
      if (candidate === el) return;
      if (NATIVE_FIELD[candidate.tagName] || candidate.isContentEditable) {
        if (isRenderedish(candidate)) { found = candidate; return false; }
      }
    }, el.shadowRoot || el);
    return found || el;
  }

  function innerClickable(el) {
    if (!el) return null;
    var tag = el.tagName;
    if (tag === "BUTTON" || tag === "A" || NATIVE_FIELD[tag]) return el;
    if (tag.indexOf("-") < 0) return el; // not a custom element, click it directly
    var found = null;
    walkDeep(function (c) {
      if (c === el) return;
      var t = c.tagName;
      var role = (c.getAttribute("role") || "").toLowerCase();
      if (t === "BUTTON" || t === "A" || role === "button" || role === "link" || NATIVE_FIELD[t]) {
        if (isRenderedish(c)) { found = c; return false; }
      }
    }, el.shadowRoot || el);
    return found || el;
  }

  // ---------------------------------------------------------------------------
  // The native setter trick
  // ---------------------------------------------------------------------------

  function nativeValueSetter(el) {
    var proto = null;
    if (el.tagName === "INPUT") proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    else if (el.tagName === "TEXTAREA") proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    else if (el.tagName === "SELECT") proto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
    if (!proto) return null;
    var d = Object.getOwnPropertyDescriptor(proto, "value");
    return d && d.set ? d.set : null;
  }

  function setValue(el, value) {
    var how = "assign";
    if (el.isContentEditable) {
      el.textContent = value;
      return "textContent";
    }
    var setter = nativeValueSetter(el);
    if (setter) {
      try { setter.call(el, value); how = "nativeSetter"; }
      catch (e) { el.value = value; how = "assign-fallback"; }
    } else {
      el.value = value;
    }
    return how;
  }

  /** composed:true is mandatory: without it a listener on the host never fires. */
  function fireInputEvents(el, value) {
    var fired = [];
    function emit(ctor, type, init) {
      try {
        el.dispatchEvent(new ctor(type, init));
        fired.push(type);
      } catch (e) {
        try {
          var ev = document.createEvent("Event");
          ev.initEvent(type, true, true);
          el.dispatchEvent(ev);
          fired.push(type + "(legacy)");
        } catch (e2) { /* give up on this one */ }
      }
    }
    if (window.InputEvent) {
      emit(window.InputEvent, "input", { bubbles: true, composed: true, data: String(value) });
    } else {
      emit(window.Event, "input", { bubbles: true, composed: true });
    }
    emit(window.Event, "change", { bubbles: true, composed: true });
    return fired;
  }

  function readValue(el) {
    if (!el) return null;
    if (el.isContentEditable) return (el.textContent || "");
    if (el.tagName === "SELECT") {
      var o = el.options && el.options[el.selectedIndex];
      return o ? (o.value != null ? o.value : o.text) : "";
    }
    if (el.tagName === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return el.checked ? "checked" : "unchecked";
    }
    return el.value != null ? el.value : "";
  }

  function describe(el, depth) {
    if (!el) return null;
    var hosts = [];
    var n = el, guard = 0;
    while (n && guard < 12) {
      var rt = n.getRootNode && n.getRootNode();
      if (rt && rt.host) { hosts.push(rt.host.tagName.toLowerCase()); n = rt.host; } else break;
      guard++;
    }
    var box = null;
    try {
      var r = el.getBoundingClientRect();
      box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { /* ignore */ }
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute ? (el.getAttribute("type") || "") : "",
      id: el.id || "",
      ariaLabel: el.getAttribute ? (el.getAttribute("aria-label") || "") : "",
      shadowDepth: depth != null ? depth : hosts.length,
      hostChain: hosts.join(" < "),
      box: box,
      disabled: !!(el.disabled || (el.getAttribute && el.getAttribute("aria-disabled") === "true")),
      readOnly: !!el.readOnly
    };
  }

  // ---------------------------------------------------------------------------
  // Text-entry eligibility
  // ---------------------------------------------------------------------------

  /**
   * Input types that hold text a user typed. Everything else -- button, submit,
   * checkbox, radio, file, image, hidden, range, color, reset -- is a control you
   * operate, not a field you fill in.
   */
  var TEXT_INPUT_TYPES = {
    text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1,
    date: 1, "datetime-local": 1, month: 1, week: 1, time: 1
  };

  function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      return !!TEXT_INPUT_TYPES[t];
    }
    return false;
  }

  /**
   * Returns a reason string when the element definitely cannot accept a text write,
   * else null.
   *
   * Custom elements are deliberately let through. A wrapper like <my-text-field> is
   * neither a field nor a definitive non-field: writing to its host is exactly the
   * host-echo case, and the descend-and-compare logic further down gives the honest
   * answer about what happened. Refusing it here would replace a precise diagnosis
   * with a vague one.
   *
   * A <select> is treated as a field so selectOption still handles it with its own,
   * more specific error message.
   */
  function textEntryProblem(el) {
    if (!el) return "no element resolved";
    if (isTextEntry(el)) return null;
    if (el.tagName.indexOf("-") > 0) return null;
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute && el.getAttribute("type")) || "";
    var what = type ? "<" + tag + " type=" + type + ">" : "<" + tag + ">";
    return "resolved to " + what + ", which does not accept a text value. "
      + "Writing to it would set a meaningless property that still reads back, so the write "
      + "would report success while changing nothing the user can see. "
      + (tag === "select"
        ? "Use the select_option action for a dropdown."
        : "Use the click action for a button or link, or target a text field explicitly.");
  }

  /** Controls that do accept text, so a refused write is actionable. */
  function textEntryCandidates() {
    var out = [];
    walkDeep(function (el) {
      if (out.length >= 10) return false;
      if (!isTextEntry(el)) return;
      if (el.disabled || el.readOnly) return;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { /* ignore */ }
      if (!r || (r.width <= 0 && r.height <= 0)) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        name: accName(el) || (el.getAttribute("placeholder") || ""),
        value: readValue(el)
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Public actions, all verified
  // ---------------------------------------------------------------------------

  function writeText(target, value, opts) {
    opts = opts || {};
    value = value == null ? "" : String(value);

    var r = resolveDeep(target);
    if (!r.el) return { ok: false, stage: "resolve", reason: r.reason, candidates: r.candidates || 0 };

    var host = r.el;

    // The node we write to, and the node we trust for verification. These differ
    // when the caller forces noDescend on a component host. A host's own `value`
    // accessor typically stores and echoes whatever you assign, so reading the
    // value back off the HOST reports success even though the real input never
    // changed. Verification must always read the inner native node.
    var el = opts.noDescend ? host : innerFocusable(host);
    var verifyNode = innerFocusable(host);
    var descended = el !== host;

    if (el.disabled) return { ok: false, stage: "precheck", reason: "element is disabled", element: describe(el) };
    if (el.readOnly) return { ok: false, stage: "precheck", reason: "element is readOnly", element: describe(el) };

    // Refuse to write text into something that is not a text-entry control.
    //
    // This is the one case read-back verification cannot catch. Assigning `.value` to
    // a <button> creates a plain expando property: the write genuinely persists, so
    // reading it back matches and verification passes. The result is a cheerful
    // "verified" for a write that went into the wrong control entirely. Hit for real
    // when a probabilistic ranker picked a button for a field goal, so the check lives
    // here rather than trusting the caller to have resolved well.
    var entryProblem = textEntryProblem(el);
    if (entryProblem) {
      return {
        ok: false,
        stage: "precheck",
        reason: entryProblem,
        element: describe(el),
        // Offer the alternatives, because the caller almost always meant one of these.
        textEntryCandidates: textEntryCandidates()
      };
    }

    if (opts.scroll !== false) {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* ignore */ }
    }
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* ignore */ } }
    var focused = el.getRootNode().activeElement === el;

    var before = readValue(verifyNode);
    var how = setValue(el, value);
    var fired = fireInputEvents(el, value);

    var after = readValue(verifyNode);
    var writtenNodeReports = readValue(el);
    var ok = after === value;
    // The dangerous case: the thing we wrote to claims the value, the real field
    // does not have it. This is exactly how fill/type report success on Lightning.
    var hostEcho = !ok && el !== verifyNode && writtenNodeReports === value;

    var reason = null;
    if (!ok) {
      reason = hostEcho
        ? "write landed on the shadow host <" + el.tagName.toLowerCase() + "> which echoed the value back, "
          + "but the real field inside it still reads " + JSON.stringify(after)
          + ". Do not pass noDescend for component-library fields."
        : "write did not persist: expected " + JSON.stringify(value) + " got " + JSON.stringify(after);
    }

    return {
      ok: ok,
      verified: ok,
      stage: ok ? "done" : "verify",
      reason: reason,
      hostEchoedValue: hostEcho,
      valueBefore: before,
      valueAfter: after,
      writtenNodeReports: el !== verifyNode ? writtenNodeReports : undefined,
      verifiedOn: el !== verifyNode ? describe(verifyNode) : undefined,
      descendedToInnerNode: descended,
      hostTag: descended ? host.tagName.toLowerCase() : null,
      setterUsed: how,
      eventsFired: fired,
      focused: focused,
      element: describe(el, r.depth),
      ambiguous: !!r.ambiguous,
      candidates: r.candidates || 1
    };
  }

  function clickDeep(target, opts) {
    opts = opts || {};
    var r = resolveDeep(target);
    if (!r.el) return { ok: false, stage: "resolve", reason: r.reason, candidates: r.candidates || 0 };

    var host = r.el;
    var el = opts.noDescend ? host : innerClickable(host);
    if (el.disabled) return { ok: false, stage: "precheck", reason: "element is disabled", element: describe(el) };

    if (opts.scroll !== false) {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* ignore */ }
    }

    var urlBefore = location.href;
    var beforeSignature = document.body ? document.body.childElementCount : 0;
    try { el.click(); } catch (e) {
      return { ok: false, stage: "act", reason: "click() threw: " + e.message, element: describe(el) };
    }

    return {
      ok: true,
      stage: "done",
      note: "click dispatched; verify the intended effect separately, a click is not proof of outcome",
      descendedToInnerNode: el !== host,
      hostTag: el !== host ? host.tagName.toLowerCase() : null,
      urlBefore: urlBefore,
      urlAfter: location.href,
      urlChanged: urlBefore !== location.href,
      bodyChildrenBefore: beforeSignature,
      bodyChildrenAfter: document.body ? document.body.childElementCount : 0,
      element: describe(el, r.depth),
      ambiguous: !!r.ambiguous
    };
  }

  function selectOption(target, wanted, opts) {
    opts = opts || {};
    var r = resolveDeep(target);
    if (!r.el) return { ok: false, stage: "resolve", reason: r.reason };

    var el = opts.noDescend ? r.el : innerFocusable(r.el);
    if (el.tagName !== "SELECT") {
      return {
        ok: false, stage: "precheck",
        reason: "resolved to <" + el.tagName.toLowerCase() + ">, not a native <select>. "
          + "Component-library dropdowns are usually a button plus a listbox: click the button, then click the option.",
        element: describe(el)
      };
    }
    var wantNorm = norm(wanted);
    var picked = -1;
    for (var i = 0; i < el.options.length; i++) {
      var o = el.options[i];
      if (norm(o.value) === wantNorm || norm(o.label) === wantNorm || norm(o.text) === wantNorm) { picked = i; break; }
    }
    if (picked < 0) {
      var avail = [];
      for (var k = 0; k < el.options.length && k < 40; k++) avail.push(el.options[k].label || el.options[k].text);
      return { ok: false, stage: "precheck", reason: "no option matched " + JSON.stringify(wanted), options: avail };
    }
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
    el.selectedIndex = picked;
    var fired = fireInputEvents(el, el.value);
    var after = readValue(el);
    var expected = el.options[picked].value != null ? el.options[picked].value : el.options[picked].text;
    return {
      ok: after === expected,
      verified: after === expected,
      stage: after === expected ? "done" : "verify",
      reason: after === expected ? null : "selection did not persist",
      selectedIndex: el.selectedIndex,
      valueAfter: after,
      eventsFired: fired,
      element: describe(el, r.depth)
    };
  }

  function inspect(target) {
    var r = resolveDeep(target);
    if (!r.el) return { found: false, reason: r.reason, candidates: r.candidates || 0 };
    var inner = innerFocusable(r.el);
    return {
      found: true,
      matchedBy: r.matchedBy,
      ambiguous: !!r.ambiguous,
      candidates: r.candidates || 1,
      matched: describe(r.el, r.depth),
      innerFocusable: inner === r.el ? null : describe(inner),
      wouldDescend: inner !== r.el,
      currentValue: readValue(inner),
      visible: isRenderedish(inner),
      reachableByQuerySelector: inner.id ? !!document.getElementById(inner.id) : "no-id"
    };
  }

  var api = {
    actionsVersion: "0.0.1",
    resolveDeep: resolveDeep,
    innerFocusable: innerFocusable,
    innerClickable: innerClickable,
    writeText: writeText,
    clickDeep: clickDeep,
    selectOption: selectOption,
    readValue: function (target) {
      var r = resolveDeep(target);
      return r.el ? readValue(innerFocusable(r.el)) : null;
    },
    inspect: inspect,
    walkDeep: walkDeep
  };

  if (window.__laya) {
    for (var key in api) if (Object.prototype.hasOwnProperty.call(api, key)) window.__laya[key] = api[key];
  } else {
    window.__laya = api;
  }

  return { installed: true, actionsVersion: api.actionsVersion, walkerPresent: typeof window.__laya.snapshot === "function" };
})();
