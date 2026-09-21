# Jev browser harnesses: the landscape

Companion to `jev-typesafe-findings.md`. Researched 2026-09-21. There are at least ten projects wrapping Jev for browser control, built in roughly the four weeks since launch. Two of them are installable MCP servers, which changes the practical answer from the first doc.

## The one finding that matters most

Every single harness in this ecosystem lists shadow DOM and iframes as out of scope. Not as a bug, as a stated limit:

- `jev-ultrafast`: "Shadow roots, frames, canvas, uploads, pop-up tabs, nested scrolling, and arbitrary keyboard widgets remain outside this MVP."
- `jev-for-chrome`: "Not handled: elements inside shadow roots or iframes, canvas UIs, file uploads, drag and drop, keyboard-only widgets."
- `jkudish/jev-browser`: "shadow DOM, and iframes are out of scope for v0.1."
- `jev-e2e`: "complex frames [...] are outside this release."

This is structural, not incidental. Jev's `Choice` primitive needs a flat, finite, pre-declared list of candidates, so the harness has to flatten the page into a numbered element table before it can ask anything. Piercing shadow roots to build that table is real engineering that nobody in this ecosystem has done yet, and it is orthogonal to Jev itself.

Practical consequence: ISC on Lightning stays blocked regardless of which harness gets picked. Same wall, different paint. Seismic is worth testing because it is less shadow-heavy, but that would need an actual trial rather than a prediction.

## The projects, ranked by how relevant they are here

### jkudish/jev-browser, the most drop-in option

Published on npm as `@jkudish/jev-browser`. Installs with `claude mcp add jev-browser -- npx -y @jkudish/jev-browser`. Also ships as a CLI and an importable library, so it can be used three ways from one install.

This is the most thoughtfully built of the lot, and the reason is the password handling. It has a real credential mechanism: a `JEV_BROWSER_PASSWORD_ORIGIN` trust anchor pinned to an exact origin, secrets piped in per run through a one-shot handoff file (validated for owner, mode 0600, no symlinks, deleted at run start) or a `JEV_PASSWORD_*` env var, and the value never reaches any model. It scrubs raw, percent-encoded, form-encoded, HTML-encoded, markdown-escaped, whitespace-normalized, and YAML-escaped echoes of the secret from every trace, error, URL, and screenshot. Video recording is refused entirely on credential runs, and a fill never submits.

That is a serious amount of care, and it is the only project here that has thought about logging in at all. Relevant because w3id auth is the actual bottleneck. Caveat: w3id is SSO with MFA, so a password fill alone will not get through it. The existing pattern of logging in by hand once in a headed browser is still the realistic route.

Other notable details: four output formats (`text`, `markdown`, `html`, `aria`) with per-format caps and honest `truncated` / `true_length` reporting. Four provider paths for the Jev calls (TypeSafe direct, OpenRouter, Cloudflare Workers AI, Vercel AI Gateway). Typing model auto-detects from whichever key is present, and can point at a local Ollama or LM Studio endpoint so no cloud text key is needed. Stop gates are in code: goal probability over 0.85, stuck probability over 0.85, step budget, time budget. Measured cost was $0.0016 for a Wikipedia Coffee to Espresso run in about 4 seconds.

One design note worth stealing: it pulls elements from the DOM directly rather than the accessibility tree, because "accessibility trees under-report inputs." They found DuckDuckGo's search box only after switching. That is directly relevant, since the current agent-browser snapshot is accessibility-tree based.

### MahmoudAdelbghany/jev-browser, the benchmarked MCP

Also an MCP server, `claude mcp add` with a path to `src/server.mjs`. Git clone only, no npm release. Requires Node 20+, Playwright Chromium, and a TypeSafe key.

Its claim: measured against Playwright MCP with the same driver model, 1.5x faster, 1.6x cheaper, same accuracy on a 12-task suite. The autonomous Jev loop alone runs at roughly 1.8 s and $0.0005 per task at 97% success. Their benchmark harness serves a local deterministic site where tasks end in per-session random codes, so success is unguessable and needs no LLM judge. That is a genuinely good methodology choice, better than most of the vendor material.

Six tools, and one of them is interesting beyond browsing: `jev_ask` batches arbitrary typed questions (choice, score, noul) against the current page in one parallel Jev call, for extraction, routing, or verification. That is usable as a "read this page and answer twelve things about it at once" primitive, which is closer to the Seismic and ISC use case than autonomous navigation is.

It also has an explicit escalation contract: `status: "escalate"` with `needs_agent: true` returns page state, ranked candidates, and reasons, so the driving agent fixes the blocker and re-invokes. That hybrid shape (Jev drives the easy steps, escalates the hard ones) is the most sensible architecture in the ecosystem.

Its own security note is blunt and worth quoting: "Run it with headless Chromium on non-sensitive sites; it is not a security boundary." Take that seriously before pointing it at internal IBM systems.

### chy4pro/jev-for-chrome, the one that solves the auth problem sideways

A Manifest V3 Chrome extension, community port of `jev-ultrafast`. No Python, no Playwright, no second browser. It drives the tab already open, in the normal Chrome profile, with existing cookies and logins.

That is architecturally the right answer to the w3id problem. Log in normally, then run the agent in that tab. It even makes the case explicitly: in a datacenter headless browser their test suite gets stopped by Cloudflare "verify you are human" pages on several sites, and the same pages open fine in a real Chrome profile.

It also publishes the most honest evaluation data anywhere in this ecosystem. A 17-task suite spanning Google Flights, Wikipedia, Hacker News, arXiv, Hugging Face, Wolfram Alpha, and BBC: 13 of 17 passed, with independent checks of the final URL or page text rather than trusting the model's own DONE. Across seven rounds the same suite scored 9, 10, 11, 14, 13, 13, and 13, and they note individual tasks flip between runs.

Read that honestly: roughly 65 to 80 percent on public sites, with run-to-run variance on the same task. That is fine for a demo and not close to good enough for unattended work on internal systems. To their credit they say so: "two websites do not prove general reliability."

Two other things they got right. A `PRESS_ENTER` control is offered explicitly rather than pressing Enter implicitly, because sites like arXiv and Wolfram Alpha have no submit button. And the DONE gate is cross-checked: the same request asks two independent Noul questions (is the task already achieved, are recent actions stuck) answered without seeing the action choice, so a DONE the goal check does not support below 50% is withheld once and the model is told what is missing.

Their failure post-mortems are also instructive. One task failed six rounds running because a shop kept old product cards in the DOM underneath the new list after sorting. They passed every visibility check, so the model kept being offered a link nobody could click. Fix was hit-testing every control and dropping ones another block covers.

Requires the `debugger` permission to dispatch trusted input through CDP, which Chrome does not allow to be optional. Can be switched to synthetic DOM events in Options. No Chrome Web Store listing, so it is load-unpacked only. MCP server is on the roadmap but not shipped.

### browser-use/jev-ultrafast, the reference

Covered in the first doc. Worth noting it does not talk to Chrome itself: it goes through Browser Harness (below). It is the thing everything else ports or reimplements, and `agent.py` plus `snapshot.js` remain the best short read in the ecosystem.

### browser-use/browser-harness, the transport layer, and not a Jev project

Worth separating out because it is easy to conflate. This is the CDP layer that `jev-ultrafast` uses to reach Chrome, but on its own it is an LLM-driven self-healing harness, no Jev involved. Connects an LLM to a real browser through one editable CDP websocket, and the agent writes missing helper functions into its own workspace as it works, so the harness accumulates capability across tasks.

It ships `browser-harness-mcp` over stdio, which means it is MCP-installable today without Jev in the picture at all. Given that the real blockers are authentication and DOM weirdness rather than decision latency, this is arguably a more relevant thing to evaluate than any of the Jev harnesses. The self-healing helper pattern is a direct answer to "the snapshot cannot see this control," which is exactly the recurring problem.

### perixtar/jev-e2e, natural-language browser testing

Different job: Playwright-backed end-to-end tests written in plain English. Each result is PASS, FAIL, or BLOCKED with an HTML report, JSON, and masked screenshots. Jev selects controls, Playwright verifies expectations independently, and missing evidence produces BLOCKED rather than a guess.

Its eBay benchmark from 2026-09-18 via OpenRouter is the only three-way model comparison in the ecosystem:

| Model | Median time | Cost per completed case | PASS / attempts | Correct UI choices |
|---|---|---|---|---|
| Jev 1.13 | 47.46 s | $0.006678 | 1/3 | 30/31 |
| GPT-5.6 Luna | 61.99 s | $0.027704 | 2/3 | 32/32 |
| Claude Sonnet 5 | 78.62 s | $0.406216 | 1/3 | 19/19 |

Jev is faster and about 60x cheaper than Sonnet 5 per completed case. But note the sample sizes: 1, 2, and 1 completed cases. They state plainly that this "does not establish a general accuracy ranking," and that three attempts were blocked by eBay availability and one by a detached-frame bug in their own observer. Do not quote these numbers as a model comparison. The cost ratio is the only part that is robust, because it follows from published pricing.

The replay feature is the interesting bit: an unchanged flow replays with zero model calls, and stale targets require Jev only to repair them. That is the right shape for any recurring automation.

### victortran0904/Jev-Browser-Use

Node local console pairing Jev with OpenCode Browser Control (a browser extension). Runs at `localhost:5173`, API on `127.0.0.1:8787`. Explicit safety model: at most 180 visible interactive elements exposed, no OCR, screenshots shown to the user but never sent to a model, action refs bound to the current observation so stale actions fail closed, runs stop on done / none / low confidence / two repeated no-ops / 12 steps. Gemini `gemini-3.5-flash-lite` writes URLs and free text only after Jev selects `open_site` or `type_text`. Intentionally local-only with no deployment config.

Good engineering hygiene, smaller scope, no MCP surface, no published evals.

### Also in the family, lower confidence

`socai-io/jev-social` does read-only browser work for social research, with Jev picking the platform and operation and code rejecting malformed or low-confidence decisions. `tontoko/jev-browser`, `hobbs/jev-agent-browser`, and `wendaoheri/jev-browser` all exist and I did not verify them. `jev-dev-kit` is a small framework extracted out of `jev-for-chrome` holding the answer validation, wire types, and loop machinery, which is the piece to look at if building something custom rather than adopting one of these.

There is also a Playwright testing-loop write-up on Substack (`jarbon`) that is honest about where the intelligence actually lives: the author supplied the testing vocabulary, predefined probes, and selectors, and Jev only chose among probes executable in the current state. He calls it "bounded adaptive exploration," which is the most accurate description of what all of these projects are doing.

## Patterns worth taking regardless of adoption

Reading across all of them, the convergent design is consistent enough to be treated as settled practice:

The model never emits a selector, coordinates, JavaScript, or a shell command. It emits an index into a table the harness built from an observed DOM node. Every project states this independently.

Operation and target are asked in the same request, with speculative target heads for each possible operation, and the non-matching ones discarded. Two decisions, one round trip. Jev charges nothing for output tokens and barely anything in latency for extra questions, so speculative fan-out is free and everyone does it.

DONE is never trusted. Verification is either independent Noul cross-checks answered without seeing the action choice, or deterministic state diffing in code, or both. Several projects also veto a low-confidence DONE once and tell the model what is missing.

Freshness and occlusion guards go in the executor, not the model. Check the node is still in the document, scrolled into view, stopped moving, and not covered by another block. The `jev-for-chrome` sorted-products bug is the canonical example of what happens without hit-testing.

Text generation is a separate, small, cheap model called only when the operation is a type. Observed choices across projects: `inception/mercury-2.5`, `gemini-3.5-flash-lite`, `claude-haiku-4.5`, `gpt-5.6-luna`, local Qwen via Ollama.

## Recommendation, updated from the first doc

The first doc said there was no MCP path. That was wrong, there are two, and one is a clean `claude mcp add` one-liner. So the "try it" barrier is much lower than I estimated.

What I would actually do, in order:

Try `@jkudish/jev-browser` as an MCP server, since it is one command and the best-engineered of the lot. Point it at a public site first to calibrate expectations, not at anything internal.

Separately evaluate `browser-harness-mcp`, without Jev. The self-healing helper pattern addresses the real recurring problem, which is the snapshot not being able to see or reach a control, and it does not depend on TypeSafe early access.

Do not expect any of this to unblock ISC. The shadow DOM limit is universal across the ecosystem and is a consequence of the flat-element-table design rather than a gap someone will patch next week.

If something does get adopted, treat `jev_ask` style batched typed questions as the more valuable half. "Read this page and answer twelve things about it in one 300 ms call" fits the Seismic and ISC reading work better than autonomous multi-step navigation does, and it sidesteps the reliability question entirely because there is no action to get wrong.

Before pointing anything at internal IBM systems, note that `MahmoudAdelbghany/jev-browser` states outright that it is not a security boundary, and that most of these projects send the page's visible text plus the full interactive element table to OpenRouter or TypeSafe on every single step. For w3id-gated internal content that is an outbound data path that needs a decision, not an assumption.

## Sources

- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
- [browser-use/browser-harness](https://github.com/browser-use/browser-harness)
- [jkudish/jev-browser](https://github.com/jkudish/jev-browser)
- [MahmoudAdelbghany/jev-browser](https://github.com/MahmoudAdelbghany/jev-browser)
- [chy4pro/jev-for-chrome](https://github.com/chy4pro/jev-for-chrome)
- [perixtar/jev-e2e](https://github.com/perixtar/jev-e2e)
- [victortran0904/Jev-Browser-Use](https://github.com/victortran0904/Jev-Browser-Use)
- [Anil-matcha/awesome-jev-by-typesafe](https://github.com/Anil-matcha/awesome-jev-by-typesafe), community index, useful for discovery, explicitly not official
- [I Put Jev in a Playwright Browser Testing Loop](https://jarbon.substack.com/p/i-put-jev-in-a-playwright-browser)
