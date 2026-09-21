/**
 * laya-ultra-browser: shadow-DOM-piercing DOM snapshot walker.
 *
 * Plain JS on purpose. This file is injected verbatim into the page (via CDP
 * Runtime.evaluate, Playwright page.evaluate, or a DevTools console paste), so
 * it must have no imports, no build step, and no syntax newer than the target
 * Chrome.
 *
 * Installs `window.__laya` with:
 *   snapshot(opts)  -> { elements, stats, meta }   build the element table
 *   resolve(ref)    -> Element | null              re-resolve a ref later
 *   fresh(ref)      -> boolean                     is that ref still usable
 *   diagnose()      -> stats only, for the go/no-go probe
 *
 * Idempotent: re-evaluating replaces the implementation but keeps the ref map
 * generation counter moving, so stale refs from a previous snapshot fail closed
 * rather than silently resolving to a different node.
 */
(function () {
  "use strict";

  var PREVIOUS = window.__laya;
  var GENERATION = PREVIOUS && typeof PREVIOUS.generation === "number" ? PREVIOUS.generation + 1 : 1;

  // ---------------------------------------------------------------------------
  // What counts as an interactive control
  // ---------------------------------------------------------------------------

  var INTERACTIVE_TAGS = {
    A: "link",
    BUTTON: "button",
    INPUT: null, // resolved from type
    SELECT: "combobox",
    TEXTAREA: "textbox",
    SUMMARY: "button",
    OPTION: "option",
    LABEL: null // only if it wraps nothing focusable; usually skipped
  };

  var INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1,
    option: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    switch: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1,
    treeitem: 1, gridcell: 1, columnheader: 1, radiogroup: 1
  };

  var INPUT_TYPE_ROLE = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
    search: "searchbox", file: "file", hidden: null, password: "password"
  };

  function inputRole(el) {
    var t = (el.getAttribute("type") || "text").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(INPUT_TYPE_ROLE, t)) return INPUT_TYPE_ROLE[t];
    return "textbox";
  }

  function explicitRole(el) {
    var r = el.getAttribute && el.getAttribute("role");
    if (!r) return null;
    // role can be a space-separated fallback list; first known wins
    var parts = r.trim().toLowerCase().split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      if (INTERACTIVE_ROLES[parts[i]]) return parts[i];
    }
    return parts[0] || null;
  }

  function roleOf(el) {
    var explicit = explicitRole(el);
    if (explicit && INTERACTIVE_ROLES[explicit]) return explicit;
    var tag = el.tagName;
    if (tag === "INPUT") return inputRole(el);
    if (Object.prototype.hasOwnProperty.call(INTERACTIVE_TAGS, tag)) {
      var mapped = INTERACTIVE_TAGS[tag];
      if (mapped) return mapped;
    }
    if (el.isContentEditable) return "textbox";
    if (el.hasAttribute && el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") {
      return explicit || "button";
    }
    return explicit || null;
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    // A bare <a> with no href is not navigable, but may still be a JS handler.
    if (tag === "A") return true;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      return t !== "hidden";
    }
    if (el.isContentEditable) return true;
    var r = explicitRole(el);
    if (r && INTERACTIVE_ROLES[r]) return true;
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Accessible name, a pragmatic subset of accname
  // ---------------------------------------------------------------------------

  function textOf(node, budget) {
    if (!node) return "";
    var t = (node.textContent || "").replace(/\s+/g, " ").trim();
    return budget ? t.slice(0, budget) : t;
  }

  function labelledByName(el) {
    var ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    var root = el.getRootNode();
    var out = [];
    ids.trim().split(/\s+/).forEach(function (id) {
      var target = null;
      try {
        target = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      } catch (e) { /* ignore */ }
      if (target) out.push(textOf(target, 200));
    });
    return out.join(" ").trim();
  }

  function associatedLabelName(el) {
    // <label for=id>, then ancestor <label>
    if (el.id) {
      var root = el.getRootNode();
      var lbl = null;
      try {
        lbl = root.querySelector
          ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]')
          : null;
      } catch (e) { /* ignore */ }
      if (lbl) return textOf(lbl, 200);
    }
    var p = el.parentElement;
    var hops = 0;
    while (p && hops < 4) {
      if (p.tagName === "LABEL") return textOf(p, 200);
      p = p.parentElement;
      hops++;
    }
    return "";
  }

  function accessibleName(el) {
    var candidates = [
      el.getAttribute("aria-label"),
      labelledByName(el),
      associatedLabelName(el),
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.getAttribute("placeholder") : null,
      el.getAttribute("title"),
      el.tagName === "IMG" ? el.getAttribute("alt") : null,
      // visible text, but only if it is not enormous
      el.tagName === "SELECT" ? "" : textOf(el, 120),
      el.getAttribute("name"),
      el.getAttribute("aria-describedby") ? null : null
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && String(c).trim()) return String(c).replace(/\s+/g, " ").trim().slice(0, 160);
    }
    // an image child's alt, common in icon buttons
    try {
      var img = el.querySelector("img[alt], svg title, use[*|href]");
      if (img) {
        var alt = img.getAttribute && img.getAttribute("alt");
        if (alt) return alt.trim().slice(0, 160);
        var tt = textOf(img, 80);
        if (tt) return tt;
      }
    } catch (e) { /* ignore */ }
    // Last resort: a stable-ish identifier, so a control is never nameless.
    // An unnamed row in the element table is useless to a model and to a human
    // reading a trace, and Lightning ships plenty of aria-label-free controls.
    var fallback = el.getAttribute("data-testid")
      || el.getAttribute("data-aura-rendered-by")
      || el.id
      || el.getAttribute("class");
    if (fallback && String(fallback).trim()) {
      return "(" + String(fallback).trim().split(/\s+/)[0].slice(0, 60) + ")";
    }
    return "";
  }

  function currentValue(el) {
    var tag = el.tagName;
    if (tag === "SELECT") {
      var opt = el.options && el.options[el.selectedIndex];
      return opt ? (opt.label || opt.text || opt.value || "") : "";
    }
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "password") return el.value ? "(set)" : "";
      if (t === "checkbox" || t === "radio") return el.checked ? "checked" : "unchecked";
      return el.value || "";
    }
    if (tag === "TEXTAREA") return el.value || "";
    if (el.isContentEditable) return textOf(el, 120);
    var checked = el.getAttribute("aria-checked");
    if (checked) return checked;
    return "";
  }

  // ---------------------------------------------------------------------------
  // Visibility and occlusion
  // ---------------------------------------------------------------------------

  /**
   * An element inside an iframe reports getBoundingClientRect in that frame's
   * coordinate space, and must be hit-tested against that frame's document, not
   * the top one. Getting this wrong makes in-frame occlusion checks return
   * whatever the top document happens to have at those coordinates, which is
   * nondeterministic garbage. Always resolve the element's own view first.
   */
  function viewOf(el) {
    var doc = el.ownerDocument || document;
    return { doc: doc, win: doc.defaultView || window };
  }

  function isRendered(el) {
    var v = viewOf(el);
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return { ok: false, rect: null }; }
    if (!rect || (rect.width <= 0 && rect.height <= 0)) return { ok: false, rect: rect };
    var style;
    try { style = v.win.getComputedStyle(el); } catch (e) { return { ok: false, rect: rect }; }
    if (!style) return { ok: false, rect: rect };
    if (style.visibility === "hidden" || style.visibility === "collapse") return { ok: false, rect: rect };
    if (style.display === "none") return { ok: false, rect: rect };
    if (parseFloat(style.opacity || "1") === 0) return { ok: false, rect: rect };
    return { ok: true, rect: rect };
  }

  function inViewport(rect, v) {
    var vw = v.win.innerWidth || v.doc.documentElement.clientWidth;
    var vh = v.win.innerHeight || v.doc.documentElement.clientHeight;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  /**
   * Hit-test through shadow boundaries, rooted at the element's own document.
   * elementFromPoint stops at the shadow host, so we descend host by host. This
   * is the check that catches the "old cards still in the DOM underneath the new
   * list" class of bug.
   */
  function deepElementFromPoint(root, x, y) {
    var node = null;
    try { node = root.elementFromPoint(x, y); } catch (e) { return null; }
    var guard = 0;
    while (node && node.shadowRoot && guard < 20) {
      var inner = null;
      try { inner = node.shadowRoot.elementFromPoint(x, y); } catch (e) { inner = null; }
      if (!inner || inner === node) break;
      node = inner;
      guard++;
    }
    return node;
  }

  function occlusion(el, rect) {
    var v = viewOf(el);
    if (!rect || !inViewport(rect, v)) return "offscreen";
    var vw = v.win.innerWidth || v.doc.documentElement.clientWidth || 1;
    var vh = v.win.innerHeight || v.doc.documentElement.clientHeight || 1;
    var x = Math.min(Math.max(rect.left + rect.width / 2, 1), vw - 1);
    var y = Math.min(Math.max(rect.top + rect.height / 2, 1), vh - 1);
    var hit = deepElementFromPoint(v.doc, x, y);
    if (!hit) return "unknown";
    if (hit === el) return "clear";
    try {
      if (el.contains(hit)) return "clear";
      if (hit.contains(el)) return "clear";
    } catch (e) { /* ignore */ }
    // The hit may be a slotted/ancestor node across a shadow boundary; accept if
    // el appears anywhere in the hit's composed ancestor chain.
    var walk = hit;
    var guard = 0;
    while (walk && guard < 40) {
      if (walk === el) return "clear";
      walk = walk.parentElement || (walk.getRootNode && walk.getRootNode().host) || null;
      guard++;
    }
    return "covered";
  }

  // ---------------------------------------------------------------------------
  // Path, for human-readable diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Cumulative offset of an element's frame chain relative to the top document,
   * so local frame coordinates can be translated for screenshots, badge overlays
   * and any coordinate-based input. Returns {x,y} in top-document space.
   */
  function frameOffset(el) {
    var dx = 0, dy = 0;
    var win = (el.ownerDocument || document).defaultView;
    var guard = 0;
    while (win && win !== window.top && guard < 10) {
      var fe = null;
      try { fe = win.frameElement; } catch (e) { break; }
      if (!fe) break;
      var r;
      try { r = fe.getBoundingClientRect(); } catch (e) { break; }
      dx += r.left;
      dy += r.top;
      win = fe.ownerDocument ? fe.ownerDocument.defaultView : null;
      guard++;
    }
    return { x: Math.round(dx), y: Math.round(dy) };
  }

  function shortTag(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList && el.classList.length) s += "." + el.classList[0];
    return s;
  }

  function pathOf(el) {
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && guard < 60) {
      parts.unshift(shortTag(node));
      var parent = node.parentElement;
      if (!parent) {
        var root = node.getRootNode && node.getRootNode();
        if (root && root.host) {
          parts.unshift("»shadow»");
          node = root.host;
          guard++;
          continue;
        }
        if (root && root !== document && root.defaultView && root.defaultView.frameElement) {
          parts.unshift("»frame»");
          node = root.defaultView.frameElement;
          guard++;
          continue;
        }
        break;
      }
      node = parent;
      guard++;
    }
    return parts.join(" > ");
  }

  // ---------------------------------------------------------------------------
  // The walk
  // ---------------------------------------------------------------------------

  function defaults(opts) {
    opts = opts || {};
    return {
      interactive: opts.interactive !== false,
      includeUrls: opts.includeUrls !== false,
      includeOffscreen: opts.includeOffscreen === true,
      includeCovered: opts.includeCovered === true,
      maxElements: typeof opts.maxElements === "number" ? opts.maxElements : 400,
      maxDepth: typeof opts.maxDepth === "number" ? opts.maxDepth : 40,
      pierceShadow: opts.pierceShadow !== false,
      pierceFrames: opts.pierceFrames !== false,
      selector: opts.selector || null,
      withPaths: opts.withPaths === true
    };
  }

  function snapshot(options) {
    var opt = defaults(options);
    var refs = new Map();
    var elements = [];
    var stats = {
      generation: GENERATION,
      visited: 0,
      interactiveFound: 0,
      emitted: 0,
      skippedOffscreen: 0,
      skippedCovered: 0,
      skippedHidden: 0,
      // the go/no-go numbers
      openShadowRootsEntered: 0,
      maxShadowDepth: 0,
      fromShadow: 0,
      suspectedClosedShadowRoots: 0,
      suspectedClosedHosts: [],
      sameOriginFramesEntered: 0,
      crossOriginFramesBlocked: 0,
      crossOriginFrameUrls: [],
      truncated: false
    };

    var startRoots = [];
    if (opt.selector) {
      var scoped = document.querySelectorAll(opt.selector);
      for (var s = 0; s < scoped.length; s++) startRoots.push({ root: scoped[s], shadowDepth: 0, frameDepth: 0 });
      if (!startRoots.length) {
        return { elements: [], stats: stats, meta: meta(), error: "selector matched nothing: " + opt.selector };
      }
    } else {
      startRoots.push({ root: document, shadowDepth: 0, frameDepth: 0 });
    }

    var queue = startRoots.slice();

    while (queue.length) {
      var job = queue.shift();
      if (job.shadowDepth > opt.maxDepth) continue;
      walkRoot(job.root, job.shadowDepth, job.frameDepth);
      if (stats.truncated) break;
    }

    function walkRoot(root, shadowDepth, frameDepth) {
      if (shadowDepth > stats.maxShadowDepth) stats.maxShadowDepth = shadowDepth;

      var all;
      try {
        all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      } catch (e) {
        return;
      }

      for (var i = 0; i < all.length; i++) {
        if (elements.length >= opt.maxElements) {
          stats.truncated = true;
          return;
        }
        var el = all[i];
        stats.visited++;

        // descend into an open shadow root
        if (opt.pierceShadow && el.shadowRoot) {
          stats.openShadowRootsEntered++;
          queue.push({ root: el.shadowRoot, shadowDepth: shadowDepth + 1, frameDepth: frameDepth });
        } else if (isCustomElement(el) && !el.shadowRoot && looksLikeClosedHost(el)) {
          stats.suspectedClosedShadowRoots++;
          if (stats.suspectedClosedHosts.length < 25) {
            stats.suspectedClosedHosts.push(el.tagName.toLowerCase());
          }
        }

        // descend into a same-origin iframe
        if (opt.pierceFrames && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
          var doc = null;
          try { doc = el.contentDocument; } catch (e) { doc = null; }
          if (doc && doc.querySelectorAll) {
            stats.sameOriginFramesEntered++;
            queue.push({ root: doc, shadowDepth: shadowDepth, frameDepth: frameDepth + 1 });
          } else {
            stats.crossOriginFramesBlocked++;
            if (stats.crossOriginFrameUrls.length < 25) {
              stats.crossOriginFrameUrls.push(el.getAttribute("src") || "(no src)");
            }
          }
        }

        if (opt.interactive && !isInteractive(el)) continue;
        stats.interactiveFound++;

        var vis = isRendered(el);
        if (!vis.ok) { stats.skippedHidden++; continue; }

        var occ = occlusion(el, vis.rect);
        if (occ === "offscreen" && !opt.includeOffscreen) { stats.skippedOffscreen++; continue; }
        if (occ === "covered" && !opt.includeCovered) { stats.skippedCovered++; continue; }

        var ref = elements.length + 1;
        var entry = {
          ref: ref,
          role: roleOf(el) || el.tagName.toLowerCase(),
          tag: el.tagName.toLowerCase(),
          name: accessibleName(el),
          value: currentValue(el),
          disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
          shadowDepth: shadowDepth,
          frameDepth: frameDepth,
          visibility: occ,
          box: {
            x: Math.round(vis.rect.left),
            y: Math.round(vis.rect.top),
            w: Math.round(vis.rect.width),
            h: Math.round(vis.rect.height)
          }
        };
        if (frameDepth > 0) {
          // box is in the frame's own coordinate space; give callers the
          // top-document position too, for overlays and coordinate input.
          var off = frameOffset(el);
          entry.frameOffset = off;
          entry.topBox = {
            x: entry.box.x + off.x,
            y: entry.box.y + off.y,
            w: entry.box.w,
            h: entry.box.h
          };
        }
        if (shadowDepth > 0) stats.fromShadow++;
        if (opt.includeUrls && el.tagName === "A") {
          entry.href = el.getAttribute("href") || "";
        }
        if (el.tagName === "SELECT") {
          entry.options = [];
          for (var o = 0; o < el.options.length && o < 60; o++) {
            entry.options.push({ index: o, label: el.options[o].label || el.options[o].text || "" });
          }
        }
        if (opt.withPaths) entry.path = pathOf(el);

        refs.set(ref, el);
        elements.push(entry);
      }
    }

    stats.emitted = elements.length;

    window.__laya.refs = refs;
    window.__laya.refGeneration = GENERATION;
    window.__laya.lastStats = stats;

    return { elements: elements, stats: stats, meta: meta() };
  }

  function isCustomElement(el) {
    return el.tagName.indexOf("-") > 0;
  }

  /**
   * Heuristic only. A closed shadow root is genuinely invisible to page script,
   * so we cannot detect it directly. But a custom element that renders a real
   * box while having no light-DOM children and no reachable shadowRoot almost
   * certainly has its content in a closed root.
   */
  function looksLikeClosedHost(el) {
    if (el.childElementCount > 0) return false;
    if ((el.textContent || "").trim().length > 0) return false;
    var h = el.offsetHeight || 0;
    var w = el.offsetWidth || 0;
    return h > 2 && w > 2;
  }

  function meta() {
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      readyState: document.readyState,
      generation: GENERATION,
      walkerVersion: "0.0.1"
    };
  }

  // ---------------------------------------------------------------------------
  // Ref resolution
  // ---------------------------------------------------------------------------

  function resolve(ref) {
    var map = window.__laya.refs;
    if (!map) return null;
    var el = map.get(typeof ref === "string" ? parseInt(ref.replace(/^@?/, ""), 10) : ref);
    if (!el) return null;
    if (!el.isConnected) return null;
    return el;
  }

  function fresh(ref) {
    var el = resolve(ref);
    if (!el) return false;
    var vis = isRendered(el);
    if (!vis.ok) return false;
    return occlusion(el, vis.rect) === "clear";
  }

  // ---------------------------------------------------------------------------
  // Diagnostic entrypoint for the Phase 0 go/no-go probe
  // ---------------------------------------------------------------------------

  function diagnose(options) {
    var opts = Object.assign({}, options || {});
    opts.withPaths = true;

    var pierced = snapshot(opts);

    // Control run: what a plain document walk would have found, no piercing.
    var flat = snapshot(Object.assign({}, opts, {
      pierceShadow: false,
      pierceFrames: false,
      withPaths: false
    }));

    // Re-run the real one so window.__laya.refs reflects the pierced snapshot.
    pierced = snapshot(opts);

    var samples = [];
    for (var i = 0; i < pierced.elements.length && samples.length < 15; i++) {
      if (pierced.elements[i].shadowDepth > 0 || pierced.elements[i].frameDepth > 0) {
        samples.push(pierced.elements[i]);
      }
    }

    return {
      url: location.href,
      title: document.title,
      verdict: verdict(pierced.stats, flat.stats),
      piercing: {
        controlsFound: pierced.stats.emitted,
        reachedThroughShadow: pierced.stats.fromShadow,
        openShadowRootsEntered: pierced.stats.openShadowRootsEntered,
        maxShadowDepth: pierced.stats.maxShadowDepth,
        sameOriginFramesEntered: pierced.stats.sameOriginFramesEntered
      },
      blocked: {
        suspectedClosedShadowRoots: pierced.stats.suspectedClosedShadowRoots,
        suspectedClosedHostTags: dedupe(pierced.stats.suspectedClosedHosts),
        crossOriginFramesBlocked: pierced.stats.crossOriginFramesBlocked,
        crossOriginFrameUrls: pierced.stats.crossOriginFrameUrls
      },
      withoutPiercing: {
        controlsFound: flat.stats.emitted
      },
      gain: pierced.stats.emitted - flat.stats.emitted,
      skipped: {
        hidden: pierced.stats.skippedHidden,
        offscreen: pierced.stats.skippedOffscreen,
        covered: pierced.stats.skippedCovered
      },
      truncated: pierced.stats.truncated,
      sampleShadowControls: samples
    };
  }

  function dedupe(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function verdict(pierced, flat) {
    if (pierced.suspectedClosedShadowRoots > 0 && pierced.fromShadow === 0 && pierced.openShadowRootsEntered === 0) {
      return "BLOCKED: shadow roots present but none reachable, likely closed";
    }
    if (pierced.crossOriginFramesBlocked > 0 && pierced.emitted <= flat.emitted) {
      return "PARTIAL: content is behind cross-origin frames, needs per-target CDP";
    }
    if (pierced.fromShadow > 0 || pierced.sameOriginFramesEntered > 0) {
      return "GO: piercing reached controls a flat walk missed";
    }
    if (pierced.openShadowRootsEntered === 0 && pierced.crossOriginFramesBlocked === 0) {
      return "N/A: this page has no shadow roots or frames, piercing changes nothing";
    }
    return "INCONCLUSIVE: shadow roots entered but yielded no extra controls";
  }

  window.__laya = {
    generation: GENERATION,
    walkerVersion: "0.0.1",
    snapshot: snapshot,
    resolve: resolve,
    fresh: fresh,
    diagnose: diagnose,
    refs: PREVIOUS && PREVIOUS.refs ? PREVIOUS.refs : new Map(),
    refGeneration: 0,
    lastStats: null
  };

  return { installed: true, generation: GENERATION, walkerVersion: "0.0.1" };
})();
