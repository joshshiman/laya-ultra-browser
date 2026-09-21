# A local Laya browser MCP: design and build plan

> **SUPERSEDED IN PART, 2026-09-21.** The Phase 0 spike disproved this document's
> central justification. agent-browser's snapshot is the browser's own
> accessibility tree over CDP, not a DOM walk, so it already reads inside shadow
> roots including closed ones, and into cross-origin frames. The shadow DOM gap
> this plan was built around does not exist, and the ISC failure appears to be a
> CSS-selector-versus-ref usage issue with no code fix required. See
> [`phase-0-spike-result.md`](phase-0-spike-result.md).
>
> Still valid and worth keeping: the Laya research and its measured limits, the
> 29-tool parity map, the auth-hold design, and the observation that every
> agent-browser tool is deterministic. Do **not** act on the phased build plan at
> the end.

Drop-in replacement for agent-browser, backed by Laya running locally on Apple Silicon. Scope agreed: full tool parity plus Laya answering typed questions about the current page. No autonomous clicking.

Researched 2026-09-21. Companion to `jev-typesafe-findings.md` and `jev-browser-harnesses.md`.

## Verdict first

This is very buildable, and it is a smaller project than it sounds, but not for the reason you'd expect. The reframe that matters:

**Every one of agent-browser's 29 tools is deterministic. There is no model anywhere in its loop.** `snapshot` is an accessibility-tree walk. `read` is an HTTP fetch plus content extraction. `click` takes a CSS selector or a ref. Not one of them calls an LLM.

So "swap agent-browser for a Laya harness" is really two independent projects that got glued together in the framing:

1. Rebuild agent-browser's 29 deterministic tools on Playwright or CDP. Laya is irrelevant to this. This is the bulk of the work, and it is also where the actual wins are (better auth, shadow DOM).
2. Add Laya as new tools alongside. Laya replaces nothing, it adds a capability agent-browser doesn't have: ask twelve typed questions about the current page in one local sub-100ms call.

The good news on (2) is that it mostly already exists. `wsargent/laya-mcp` ships today: a local MCP server over `laya-mlx` with a `laya_decide` tool that takes arbitrary choice/score/noul questions, plus a warm daemon at `127.0.0.1:8742/mcp` so the model stays resident. You can install that this afternoon and get the Laya half without writing anything.

So the real project is (1), and the honest reason to do it is not speed. It's shadow DOM and auth.

## Laya: what's actually there

Real, Apache 2.0, from Convai Innovations (Nandha Kishor M). Three checkpoints under `convaiinnovations/laya`:

| Checkpoint | Encoder | Params | Context | For |
|---|---|---|---|---|
| `laya` | ModernBERT-large | 421M | 512 | English, general |
| `laya-multilingual` | mmBERT-base | 322M | 1024, possibly 8k | 45 of 51 languages tested above 3x random |
| `laya-typed-decisions` | ModernBERT-large | 421M | 1024 | four specific workflows |

Two notes on that table. The announcement page lists multilingual's context as "1024 (up to 8k)" while `laya-mlx`'s own table says a flat 1,024. The sources disagree and I have not resolved it; if 8k is real, the context-budget risk below is much smaller than I've stated. And the "100+ languages" figure is marketing: their own 51-language sweep found 45 usable at above 3x random.

Same three primitives as Jev: `choice`, `score`, `noul`. Bidirectional encoder, single forward pass, no token decoding, no generated JSON. Schema violations are structurally impossible, same as Jev.

The Mac story is solid. `laya-mlx` is `pip install laya-mlx`, Apple Silicon, Python 3.11+, macOS 14+. Important caveat on provenance: this is an independent port by `mizorewww`, explicitly "not an official Convai Innovations release," and the figures below are that author's self-reported measurements rather than vendor numbers. Measured on an M3 Max:

| | Laya 421M | Multilingual 322M |
|---|---|---|
| One short question, P50 | 13.42 ms | 7.39 ms |
| One short question, P95 | 13.92 ms | 7.79 ms |
| 50-question throughput | 146.8 q/s | 395.0 q/s |
| Peak MLX allocation | 943.6 MiB | 687.6 MiB |

Port fidelity was checked, narrowly: all three checkpoints matched upstream's selected answer on 63/63 validation questions in both FP32 and FP16, 378/378 comparisons, with no measured memory growth over 100 repeated calls. The source adds that this "measures fidelity on those fixtures, not accuracy on every possible question." 63 questions is a smoke test, not an equivalence proof.

For your purposes the throughput number matters more than the latency one. 146.8 questions per second implies asking 20 things about a page costs roughly 140 ms, locally, free. Treat that as an upper bound on optimism rather than a forecast: the measurement used short questions at `batch_size=64` while the API defaults to 16, excluded model loading, and the source notes that "different lengths, question counts and runtime conditions change latency." `page_ask` sends packed page state, meaning long questions at the default batch size, so real numbers will be worse. Likewise the 943.6 MiB is peak allocation for one short question; no batched memory figure is published, so "under a gig" is not a safe planning assumption for a 20-question call.

### Two limits that shape the whole design

**The ~20 option ceiling.** This is the big one. Laya's `choice` options share a fixed 192 to 256 token head budget, so accuracy collapses as the label space grows. On Banking77 (77 labels) Laya scored 0.425 against Jev's 0.870. Their own guidance: keep choice schemas under 20 options, or use a coarse-to-fine hierarchy.

Jev supports 255 options, and every Jev browser harness leans on that. `jkudish/jev-browser` offers up to 240 elements per step. That entire approach is unavailable here. Any element-selection-by-choice design has to pre-rank down to under 20 candidates first, or restructure as per-element `noul` questions batched together.

Do not read the ceiling as a cliff at 20, though. Their own 10-way support ticket routing scored 0.522, which is well inside the recommended range. Degradation starts early and the 20 figure is where it becomes unusable, not where it begins.

Since we scoped out semantic targeting, this mostly doesn't bite. Worth knowing because it's the thing that would block Phase 3 if you ever want it, and because `noul` is Laya's strongest primitive anyway (0.857 accuracy vs 0.733 for choice), so the per-element-noul restructuring is probably the right answer if you get there.

**Zero-shot is near random on anything it wasn't tuned for.** Base Laya scores 0.362 on the typed-decisions benchmark. The headline 0.766 comes from fine-tuning on that benchmark's train split. Their own words: "treat Laya as a fast foundation model to specialize, not as an omniscient zero-shot oracle."

The published application workflows look more encouraging: Enron spam 0.993, phishing 0.980, ToxicChat guardrails 0.755 to 0.762, RAG passage relevance 0.657. Relevance-of-this-content-to-my-question is the shape you'd be using for `page_ask`, so 0.657 is the number to plan against. But note the source never states whether those figures are base-checkpoint or specialized, so do not assume they are what you'd get out of the box.

**Calibration needs fitting, and the two sources disagree about how well it lands.** Base weights ship with raw temperature logits, and the announcement says fitting one scalar temperature per question type cuts ECE from 0.466 to 0.081. But the typed-decisions model card, on the same benchmark, reports Laya at ECE 0.213 against Jev's 0.144, calls the model "still over-confident," and warns that its `temperature_by_options` was inherited from the base checkpoint and *overrides* the per-type temperatures fitted for this model. Same card shows soft accuracy trailing Jev, 0.471 vs 0.580, meaning its argmax is better but its distributions are worse. Treat calibration as unsolved work, not a switch you flip.

**The claim that confidence gating protects you is contradicted by the vendor's own data.** This is the most important caveat in this doc and I had it wrong in a first pass. Their 51-language sweep found the English checkpoint scoring 0.000 accuracy on Khmer at 0.952 mean confidence, 0.060 on Hebrew at 0.964, and mean confidence never dropping below 0.885 "regardless of whether its accuracy is 82% or 0%." Their conclusion, verbatim: "Therefore, confidence gating cannot protect you."

Their framing is about script mismatch, which the router solves, so this is not a direct refutation of confidence gating on in-distribution English pages. But it means the premise of Phase 4 is untested rather than assumed, and it should be validated on your own labelled data before anything branches on a confidence threshold. There's a hint at a better mechanism in the same material: ToxicChat reaches 0.931 accuracy at 50% selective coverage. That's a coverage-based gate (answer the easy half, defer the rest) rather than a confidence-based one, and it may be the more defensible design.

One caution on their Jev comparison table generally. Every Laya number is measured; the Jev numbers are third-party published from different prompts and sample sizes. The model card says so directly: "treat the comparison as indicative." The headline "7.8x faster than Jev" is their own single-GPU 32.8 ms against Jev's 236 to 276 ms metered API, not the MLX figures above, so it compares local inference to a network round trip rather than architecture to architecture. The latency and open-weights advantages are real and uncontroversial. The accuracy edge is not established.

## Parity map: agent-browser's 29 tools

All deterministic. Grouped by how much work each group is.

**Trivial, thin Playwright wrappers (17 tools).** `back`, `forward`, `reload`, `click`, `fill`, `type`, `press`, `check`, `uncheck`, `select`, `scroll`, `get_text`, `get_title`, `get_url`, `wait_for_load`, `wait_for_selector`, `wait_for_text`. Playwright has a direct equivalent for each. A day or two total, most of it spent on matching the exact parameter names so the swap is truly drop-in: `selector` accepting either a CSS selector or an `@ref` from a snapshot, `newTab` on click, `clear` and `delayMs` on type, `values` as an array on select, `direction`/`amount`/`selector` on scroll.

**Easy but fiddly (5 tools).** `wait_ms`, `tab_list`, `tab_new`, `tab_switch`, `tab_close`. Tabs need a label registry so `tab` accepts either an id or a human label. Half a day.

**The real work (4 tools).**

`snapshot` is the heart of it. Returns an accessibility-tree snapshot with stable refs, and supports `selector` scoping, `compact`, `depth`, `interactive`, and `includeUrls`. The ref stability is the hard part: refs have to survive between the snapshot call and the click call, which means a node identity cache keyed to the live DOM nodes plus a freshness guard that fails closed when the page moved underneath you. Every Jev harness independently reinvented this and they all describe it the same way. Borrow from `jev-ultrafast`'s `snapshot.js` and `jev-for-chrome`'s `content/snapshot.ts` rather than starting cold. This is where the shadow DOM work lands too, see below.

`read` is not a browser tool at all. It's an HTTP fetch that prefers `text/markdown`, with `raw`, `requireMd`, `readTimeoutMs`, plus `outline` for a heading tree, `filter` for section filtering, and `llms: index|full` which walks up to the nearest-ancestor `llms.txt` / `llms-full.txt`. That llms.txt discovery is a genuinely distinctive feature and is maybe 100 lines on its own. Reimplement with a plain HTTP client plus Readability; don't try to do it through the browser.

`screenshot` needs `fullPage`, `format`, `quality`, `selector` scoping, `path`/`screenshotDir`, and `annotate` (number the visible elements in the image). Playwright gives you all but `annotate`, which means injecting numbered badge overlays before capture and tearing them down after. `jev-for-chrome`'s `content/overlay.ts` does exactly this.

`eval` runs arbitrary JS via stdin to dodge shell escaping. Trivial to implement, and it is also your universal escape hatch: anything you fail to reach with a typed tool, you can reach with `eval`. Worth implementing early for that reason.

**Meta (1 tool).** `tools_profiles` lists startup profiles. Stub it.

**Session and lifecycle plumbing, easy to forget.** Not tools, but every tool takes them and they are load-bearing:

- `session` for named isolated browser sessions, `namespace` for isolated daemon sockets and restore-state dirs
- `restore` (true, or a string key) plus `restoreSave: auto|always|never` and the three verification predicates `restoreCheckUrl`, `restoreCheckText`, `restoreCheckFn`
- `allowedDomains`, which restricts both browser and read traffic and additionally disables `RTCPeerConnection` on Chromium
- `headed`, `webgpu`, `idleTimeout` for daemon shutdown, `timeoutMs` per call

The `restore` plus `restoreCheck*` cluster is worth staring at, because it is already an auth-persistence-with-verification mechanism. You're not inventing the auth feature, you're fixing it.

`allowedDomains` deserves a note: it's a real egress control, and given the concern from the last doc about page text leaving the machine, a local-model design makes it much less critical. Nothing leaves at all if Laya is local. That is arguably the strongest argument for this whole project.

## The auth hold, which is what you actually asked for

Two layers, and the first one matters more.

**Attach to your real Chrome, don't launch a new browser.** Playwright's bundled Chromium with a fresh profile means re-doing w3id SSO plus MFA every session, because device trust cookies live in your everyday profile. `jev-for-chrome` solved this by being a Chrome extension running in the tab you already have open, and they report the collateral benefit that Cloudflare "verify you are human" interstitials which block headless datacenter browsers just don't appear in a real profile. `browser-harness` does the same thing differently, connecting over one CDP websocket to your actual browser after you tick the box at `chrome://inspect/#remote-debugging`.

Take the CDP-attach route. Connect to your running Chrome over the DevTools protocol, operate in a tab in your real profile. Then w3id is a thing you do once, as yourself, and the harness inherits it. This is the single design decision that determines whether the auth story works.

Fallback if attaching to your daily driver feels wrong: a dedicated persistent `user_data_dir` that you log into once and never clear. Better than fresh-profile, worse than real-profile, because MFA device trust will still occasionally re-challenge.

**An explicit blocking gate.** Add a tool agent-browser doesn't have:

```
browser_await_auth(
  check_url:  optional URL pattern that must match
  check_text: optional text that must be present
  check_fn:   optional JS expression that must evaluate truthy
  timeout_ms: how long to hold, default generous, say 300000
  message:    what to tell the user to go do
)
```

It blocks, polls the predicate every second or so, and returns as soon as the page satisfies it or the timeout fires. Semantics identical to the existing `restoreCheck*` predicates, just as a first-class tool you can call mid-flow instead of only at session start. So the pattern becomes: open the ISC page, call `browser_await_auth` with a check for a logged-in marker, you do the SSO and MFA by hand in the visible window, the tool returns, everything downstream runs authenticated.

Pair it with the storage-state save on success, so the next session usually skips the manual step entirely and only falls back to the gate when the cookie has aged out. That combination (real profile, plus explicit hold, plus state save with verification) is as good as this gets without automating MFA, which you should not do.

## Shadow DOM: the actual prize

From the previous doc: every Jev harness in the ecosystem lists shadow roots and iframes as out of scope, and ISC on Lightning is shadow DOM all the way down. Nobody is going to fix this for you, and it's the difference between this project being a curiosity and being useful.

It's tractable. The snapshot walker currently does a `document` tree walk. It needs to also:

- recurse into `element.shadowRoot` whenever one exists, for open roots
- recurse into `iframe.contentDocument` for same-origin frames, and handle cross-origin frames as separate CDP targets
- keep the ref namespace flat across all of it, so a ref from inside a shadow root still resolves to a real node later
- carry a path back to the owning root, so the executor can re-resolve and freshness-check a node it reached through three levels of shadow

Closed shadow roots are genuinely inaccessible from page script, and that's a real limit to state up front. Lightning uses open roots for the most part, which is why this is worth attempting rather than hopeless. But I would not promise it works until it's been pointed at an actual ISC opportunity page, which is why I'd suggest spiking this before committing to the rest.

This is also why `eval` is worth building on day one. Even a half-working shadow walker plus `eval` for the gaps beats a perfect a11y-tree snapshot that can't see the field you need.

## Architecture

```
Claude Desktop
   │
   ├── laya-browser-mcp   (new, the project)
   │      29 parity tools + browser_await_auth + page_ask
   │      │
   │      ├── CDP ──► your real Chrome, your real profile, your w3id session
   │      └── HTTP ──► laya daemon at 127.0.0.1:8742
   │
   └── laya-mcp           (exists today, install as-is)
          laya_decide / laya_triage / laya_guard / laya_moderate / laya_email
          └── laya-mlx ──► MLX ──► Apple Silicon GPU
```

Two servers, not one. `laya-mcp` already does general typed decisions well and keeps a warm resident model; don't reimplement it. Your browser MCP forwards page questions to its daemon over HTTP.

The one Laya-flavoured tool worth adding to the browser server, because it needs the page state that only the browser server has:

```
page_ask(
  questions:  a dict of choice/score/noul definitions
  scope:      optional selector to narrow what gets read
  include:    which page facts to send as state, e.g. text, links, elements, title, url
)
```

That's the `jev_ask` pattern from `MahmoudAdelbghany/jev-browser`, which was the most useful single idea in that whole survey. "Read this Seismic search results page and tell me, for each of these 15 results, whether it's relevant to a mining client in Western Canada" becomes one batched local call at about 140 ms and zero cost. No action to get wrong, no reliability question, and it plays to `noul`, Laya's best primitive.

Watch the context budget: 512 tokens for the English checkpoint, 1024 for multilingual and typed-decisions, and that includes instructions plus options plus state. That is small. Page text has to be aggressively scoped and chunked, and for long pages you'll be map-reducing across chunks rather than sending the page. This is a sharper constraint than anything else in the design and it is easy to miss.

Note that `laya-mcp` defaults `LAYA_MCP_MODEL` to `convaiinnovations/laya`, the 512-context English checkpoint, so out of the box `page_ask` gets 512 tokens. Set that env var deliberately. Two other `laya-mcp` specifics to plan around: it requires Python 3.12+ where `laya-mlx` says 3.11+, and its daemon forwarding timeout defaults to 15 seconds, which a large batched call could plausibly exceed on a cold model.

## What you build vs what exists

| Piece | Status |
|---|---|
| Laya local inference on Mac | `pip install laya-mlx`, done |
| Laya as MCP tools | `wsargent/laya-mcp`, done, install it (check its license first, none stated) |
| Warm resident model daemon | in `laya-mcp`, done |
| Ref-stable DOM snapshot | borrow from `jev-ultrafast` / `jev-for-chrome` |
| Freshness and occlusion guards | borrow, same sources |
| Numbered-badge overlay for `annotate` | borrow `jev-for-chrome/content/overlay.ts` |
| CDP attach to real Chrome | borrow the approach from `browser-harness` |
| 29 parity tools with exact signatures | you build |
| `llms.txt` discovery for `read` | you build |
| Shadow DOM and iframe piercing | you build, nobody has this |
| `browser_await_auth` | you build |
| `page_ask` | you build, thin |
| Temperature calibration on your questions | you build, needs labelled data |

## Phased plan

**Phase 0, spike the risky part. 1 to 2 days.** Write only the shadow-piercing element walker, as a standalone script you inject with the existing agent-browser's `eval`. Point it at a real ISC Lightning page and count how many of the controls you actually need come back with resolvable refs. If the answer is "most of them," the project is worth it. If it's "none, they're closed roots," stop here and you've spent two days instead of two months.

**Phase 1, the deterministic MCP. 1 to 2 weeks.** CDP attach to real Chrome, the 29 tools with exact signature parity, session and namespace plumbing, `restore` with the three check predicates, `browser_await_auth`. Ship `eval` first so you always have an escape hatch. At the end of this phase you can swap it for agent-browser in the config and everything that worked before still works, plus auth is less painful and shadow DOM is reachable. Note that Laya has contributed nothing yet, and the project is already net positive.

**Phase 2, install `laya-mcp`. An afternoon.** Clone, `uv sync`, register it, run the daemon. Get a feel for `laya_decide` on real content before wiring anything.

**Phase 3, `page_ask`. 2 to 3 days.** Wire the browser server to the Laya daemon. Build the state packer, which is the real work: scoping, chunking to the 512 or 1024 token budget, and deciding which page facts to include per call.

**Phase 4, calibration. Ongoing, a few days of concentrated effort, and the least certain phase.** Collect a few hundred labelled examples of the questions you actually ask about Seismic and ISC pages, then fit per-question-type temperature and measure whether confidence actually tracks accuracy on your distribution. Do not assume it will, per the confidence-gating caveat above. If it doesn't, fall back to a coverage-based gate: rank by probability, answer the top half, defer the rest to an LLM or to yourself. That's the mechanism behind their ToxicChat 0.931 at 50% coverage and it survives poor calibration, because it only needs the ordering to be right rather than the absolute numbers.

Total to a genuinely useful state: roughly three to four weeks of focused part-time work, with a two-day off-ramp at the front. Phases 1 and 3 are independently valuable, so there's no point where you're holding a half-finished thing.

## Risks, honestly

**The spike fails.** Lightning turns out to use closed shadow roots for the controls you need. Mitigation is Phase 0 costing two days.

**512 tokens is really small.** This is the constraint I'd worry about most after shadow DOM. The English checkpoint's context has to hold instructions, options, and state. Real page text does not fit. You will be chunking, and chunking changes what questions are answerable. Consider `laya-multilingual` for its larger context, accepting the accuracy tradeoff, and resolve the 1024-versus-8k discrepancy between the two sources early since it materially changes how much this hurts.

**Confidence may not be gateable.** Covered above. The vendor's own sweep says confidence carries no warning signal when the model can't read the input, and their calibration numbers conflict between sources. Phase 4 has to prove this works on your data rather than assume it. Coverage-based gating is the fallback.

**Zero-shot quality on page questions is unknown.** RAG passage relevance at 0.657 is the closest published proxy, it's mediocre, and the source doesn't even confirm it's a base-checkpoint figure. If it's not good enough after calibration, the fix is fine-tuning: their Kaggle 2xT4 notebook runs in about 4 to 5 hours free, but you'd first have to build a labelled dataset of your own page judgements, which is the real cost and is measured in weeks not hours.

**Maintenance burden is now yours.** agent-browser is maintained by someone else. A hand-rolled parity layer breaks when Chrome changes, when Lightning's DOM changes, when Playwright bumps. That is a permanent tax and it is the strongest argument against doing this at all.

**Three moving, thinly-staffed dependencies.** `laya-mlx` is at 0.1.0, published 2026-09-19, and is an unofficial community port rather than a vendor release. `laya-mcp` is newer still and its README states no license at all, so don't assume the Apache 2.0 that covers the weights and the MLX port extends to it. Each is essentially one person's work. Pin versions and revisions, which `laya-mlx` supports explicitly via `revision=`.

## What I'd actually do

Phase 0 this week. The whole question is whether shadow DOM piercing works on ISC, and two days answers it. Everything else in this plan is ordinary engineering with known-good prior art to crib from; that one thing is the unknown, and it's also the only reason to prefer building over adopting.

Independently and immediately: install `laya-mcp`. It's an afternoon, it's useful on its own for classification and relevance scoring with no browser involved, and it tells you whether Laya's judgement quality is anywhere near good enough before you commit to the larger build.

## Sources

- [Laya announcement and benchmarks](https://laya.convaiinnovations.com/), Convai Innovations
- [convaiinnovations/laya-typed-decisions](https://huggingface.co/convaiinnovations/laya-typed-decisions), model card with the honest limits section
- [laya-mlx on PyPI](https://pypi.org/project/laya-mlx/), the Apple Silicon port, M3 Max measurements
- [wsargent/laya-mcp](https://github.com/wsargent/laya-mcp), existing local MCP server
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), snapshot and freshness-guard prior art
- [browser-use/browser-harness](https://github.com/browser-use/browser-harness), CDP attach to a real browser
- [chy4pro/jev-for-chrome](https://github.com/chy4pro/jev-for-chrome), real-profile argument, overlay and occlusion handling
- [jkudish/jev-browser](https://github.com/jkudish/jev-browser), credential handling patterns, DOM vs a11y-tree finding
- [MahmoudAdelbghany/jev-browser](https://github.com/MahmoudAdelbghany/jev-browser), the `jev_ask` batched-questions pattern
- agent-browser tool surface read directly from this session's MCP tool definitions
