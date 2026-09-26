# Contributing

Thanks for looking. This document is short because the project is small and the bar is
specific.

## Getting set up

```bash
git clone https://github.com/joshshiman/laya-ultra-browser
cd laya-ultra-browser
npm install
npx playwright install chromium
npm run check
```

`npm run check` runs the typecheck and the full suite. It should pass on a clean
checkout with no configuration and no model installed.

The Laya tests skip themselves automatically when no interpreter can import the model
runtime. To exercise them:

```bash
npm run setup:laya
npm run test:browser
```

## The rules that matter

**A write is not done until it has been read back.** This is the entire point of the
project. If you touch `actions.js`, keep the read-back, and add a fixture assertion for
whatever you changed. A change that makes a write *look* successful is a regression
even if every existing test still passes.

**Report failure as failure.** No cheerful success for something that did not happen.
If a step is skipped, say which and why.

**stdout belongs to the protocol.** The server speaks JSON-RPC on stdout. Every
diagnostic goes to `stderr` via `src/log.ts`. A single stray `console.log` corrupts the
stream and the client disconnects with a parse error that points nowhere near the cause.

**Timeouts on anything that can wait.** Network, model, navigation, browser launch.

**Error messages are for the agent reading them.** Say what happened, and what to do
about it. `ActionableError` takes an optional `hint` for exactly this.

## Changing the in-page layer

`src/snapshot/walker.js` and `src/snapshot/actions.js` are plain ES5-compatible
JavaScript with no imports, because they are injected verbatim into arbitrary pages.
Keep them that way: no build step, no syntax newer than the target browser, no
`console.log` (it would write to the page's console, not yours).

After changing either:

```bash
npm run build:inject   # regenerate the comment-stripped copies
npm test
```

The fixture is the contract. `test/fixtures/shadow-lab.html` should grow an assertion
whenever you add behaviour.

## Tests

- `test/unit/` — pure logic, no browser. Fast; run these while iterating.
- `test/browser/` — real Chromium: the conformance fixture and the Laya bridge.
- `test/integration/` — spawns `dist/server.js` and speaks MCP to it over stdio.

`test/unit/harness.test.ts` guards the harness itself, because this project once shipped
a `npm test` that ran zero tests and exited 0. If you add a suite, it is picked up.

## Style

Match the surrounding code. TypeScript above the in-page layer, with `strict`,
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on — they catch real bugs
and the build depends on them staying on.

Comments should explain **why**, not restate the code. The existing comments earn their
place by recording a non-obvious constraint or a bug that was already hit once; keep
that bar.

## Reporting a bug

The most useful reports include:

- the URL or a reduced fixture that reproduces it
- the tool call you made and the full response, including `verified` and `reason`
- `browser_status` output
- the server's stderr with `LAYA_LOG_LEVEL=debug`

If a write reported success but did not happen, that is the most important class of
report there is. Say so plainly and include the element description from the response.

## Licence

By contributing you agree that your work is licensed under the MIT licence, the same as
the rest of the project.
