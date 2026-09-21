# Jev (TypeSafe AI) for browser automation: findings

Researched 2026-09-21. Sources are listed at the bottom, with a note on which ones to distrust.

## Headline correction

Jev is not a browser automation model. That framing is floating around in the secondary coverage, and it is misleading.

Jev is TypeSafe AI's first "System One Model." It does not generate text at all. You send it unstructured state plus a set of typed questions, and it returns typed values with calibrated probabilities. There are exactly three primitives: `Choice` (pick one option from a list, returns choice + probabilities + confidence), `Score` (rate against a rubric), and `Noul` (is this statement true, returns 0 to 1). All questions in a call are evaluated in parallel and in isolation against the same state, so adding questions barely moves latency.

So Jev is closer to a very fast, very cheap, non-hallucinating `if`-statement than to an agent. The company's own description is "a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out."

The browser automation you read about is a downstream application, built by the Browser Use team in a repo called `jev-ultrafast`. That is where the speed claims for browsers actually come from, and it is the thing worth evaluating.

## Why it is fast, architecturally

The `jev-ultrafast` loop is genuinely clever and the design is the interesting part, more than the model:

1. Snapshot the DOM in one atomic browser call, producing an indexed table of visible controls with names and values. No screenshots in the default loop.
2. Send that element table to Jev as state, and ask for the operation and the target in a single request. The operation space is fixed and small: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`.
3. Target heads are speculative and fanned out. It asks for `click_target`, `type_text_target`, and `select_target` at the same time as the operation, then discards the ones that do not match. Two decisions, one network round trip.
4. A small, separate LLM is called only when the operation is `TYPE_TEXT`, purely to write the string. The demo uses `inception/mercury-2.5` with reasoning off, via OpenRouter.

The key structural difference from a normal browser agent: the action space is a closed, indexed set derived from the live DOM. The model never emits a selector, coordinates, JavaScript, or a shell command. It emits an index into a table the harness built. That is why they can claim zero type errors and no hallucinated actions, and it is mathematically rather than empirically true.

## The actual numbers, and how much to trust them

From the repo's own evidence section:

- Zürich to London on Google Flights: 7,073 ms end to end, including model calls, text generation, browser work, and loading waits.
- Against their own prior version, six alternating runs, identical models: median task time 9.450 s to 7.092 s, a 25% reduction. Median browser protocol calls 1,092 to 101.
- Wikipedia article open: 2.798 s. Local hotel search and filter: 1.896 s.

Read that carefully. The 25% improvement is versus their previous iteration, not versus a conventional browser agent, and it is three repeats of one task on one browser profile. They say so explicitly. The 10x drop in browser protocol calls is arguably the more meaningful number, because that is the atomic-snapshot design paying off and it is independent of the model.

TypeSafe's own top-line claims, 193.6x faster and 444.6x cheaper, come from their internal workflow evals, not from browsers. Their stated per-call latency is 70 ms to 500 ms. Input pricing is $0.042 per MTok, output tokens free. They benchmark against the average of GPT-6 Astra and Fable 5.1 as reference, and they concede in their own nuance sections that the workflows were authored by their model capabilities team and that the reference choice biases toward OpenAI and Anthropic models.

To their credit, they publish the caveats unprompted, which is more than most launch posts do.

## Would this replace the agent-browser setup

For the internal IBM work, no, and the blockers are specific rather than vague.

**Shadow DOM and frames are explicitly out of scope.** The repo lists "shadow roots, frames, canvas, uploads, pop-up tabs, nested scrolling, and arbitrary keyboard widgets" as outside the MVP. That is precisely the wall already hit with ISC on Lightning, where selectors could not pierce the shadow DOM. Jev would not fix that. It would fail at the same layer, just faster.

**Seismic and ISC are w3id-gated.** The current pattern is a headed browser on VPN where the SSO and MFA login is done by hand once, then the agent runs authenticated after. `jev-ultrafast` connects to Chrome over remote debugging using an existing profile, so session reuse is plausible in principle. But it is a standalone Python library with a local inspector on port 8766, not an MCP server. There is no drop-in path into the current Claude Desktop tool surface without writing a wrapper.

**It needs two API keys.** `TYPESAFE_API_KEY` plus a text model key. TypeSafe access is waitlist and early access only right now, so this is not something to just pick up and try today.

**Different job.** agent-browser is a general driver, snapshot, click, fill, read, eval, across arbitrary sites, with an accessibility-tree snapshot that returns stable refs. `jev-ultrafast` is a goal-driven autonomous loop: one natural-language goal in, it decides its own steps. Those are not substitutes. For the current work, which is mostly "go to this known page, read this known field," the bottleneck is authentication and DOM weirdness, not decision latency. Jev optimises the part that is not the problem.

## Where Jev itself is actually worth a look

Separating the model from the browser repo, the `Choice` / `Score` / `Noul` primitives look like a good fit for a few things already in flight:

- Scoring or routing large batches of content, for example triaging Seismic search results for relevance to a specific account, or classifying notes.
- Guardrails and verification on other agents' output. TypeSafe pitches it directly as a judge and jailbreak detector, and the calibrated confidence makes a real threshold possible instead of a vibe.
- Anywhere there is a hand-written brittle heuristic that would be better as a fuzzy decision with a confidence number attached.

The documented design pattern is worth internalising regardless of whether the model gets used: decompose a judgement into atomic, independently-evaluated questions, then combine them with a formula in code, so tuning priorities means changing a coefficient rather than rewriting a prompt. That is good advice for LLM workflows too.

## Recommendation

Do not move any browser automation onto this yet. Join the TypeSafe early access waitlist, and if it comes through, prototype Jev on a classification or scoring task rather than on a browser task, because that is where the model's actual shape fits and where it can be evaluated without fighting authentication.

Separately, read `agent.py` and `snapshot.js` in `jev-ultrafast`. The repo is deliberately small and the atomic-snapshot and freshness-guard techniques are borrowable into the existing setup without adopting Jev at all. That is probably the highest-value thing to take from this.

## A warning on sources

Searching for this throws up a cluster of lookalike domains: `jevtypesafeai.com`, `jevtypesafe.org`, `jevplayground.com`, `jevai.net`, `jev-agent.com`, `jevapi.org`, `jevapi.dev`. None of these are TypeSafe properties. They are SEO pages built on a hot launch keyword, and several claim to offer API keys or quickstarts. Do not enter credentials on any of them. The only authoritative sources are `typesafe.ai`, `docs.typesafe.ai`, and the `browser-use` GitHub org.

## Sources

- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe AI blog, Diogo Almeida
- [TypeSafe AI home](https://typesafe.ai/), headline speed and cost claims
- [Introduction](https://docs.typesafe.ai/introduction) and [Quick start](https://docs.typesafe.ai/introduction/quickstart), TypeSafe docs
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), the actual browser agent, loop design, and measurements
