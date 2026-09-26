# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-26

First release. The two injection scripts that made up this repository are now wrapped in
a real MCP server, tested end to end, and documented.

### Added

**MCP server.** Nine tools over stdio, driving Playwright's Chromium: `browser_navigate`,
`browser_snapshot`, `browser_find`, `browser_write_text`, `browser_click`,
`browser_select_option`, `browser_inspect`, `browser_read_value` and `browser_status`.
Lazy launch, signal and stdin-close cleanup, idle release.

**Verified writes.** Every mutating call resolves through open shadow roots, descends
from a component host to the real inner control, writes through the native prototype
value setter, fires `input` and `change` with `composed: true`, and reads the value back
off that control. Three failure shapes are reported separately because they need
different fixes: `resolve`, `precheck` and `verify` (with a distinct `hostEchoedValue`
flag for wrappers that echo an assigned value back).

**A refusal for non-fields.** A write aimed at a `<button>` creates a plain expando
property: the value persists, the read-back matches, and an unguarded layer reports
success for a write that changed nothing. `writeText` now refuses targets that cannot
hold a value and lists the text fields you could have meant.

**Local Laya ranking.** A persistent Python bridge over NDJSON, so the model loads once
rather than per call. Candidates are pre-filtered lexically to fit the model's option
budget, ranked in one forward pass, and the top pick is handed to the verified layer.
The deterministic name-and-role matcher runs on every goal regardless, so a disagreement
is always detectable.

**Flat-ranking detection.** A ranking whose scores are all but identical is treated as no
decision at all and falls back to the deterministic answer, because reporting an
arbitrary first place as a confident pick is the worst version of that bug.

**Optional live visualizer.** Off by default. A loopback dashboard showing each ranking
as it lands: the goal, every candidate's score as an animating bar, the resulting order,
the chosen ref, the mode, how many candidates were pruned, latency, and the calibration
warning. Disagreements with the deterministic matcher are shown explicitly, with both
picks named. Bounded ring buffer, port fallback, and a thrown subscriber cannot fail a
tool call.

**Stale-ref guard.** Refs are re-checked before use, and a failure names which of four
things went wrong: gone, not rendered, scrolled out of view, or covered.

**Install.** One MCP config entry via `npx github:joshshiman/laya-ultra-browser`, with a
`prepare` script so npm compiles it for git dependencies. A `uv`-based setup script
creates the Laya environment under `~/.laya-ultra-browser` without touching any system
Python.

**Tests: 152.** The shadow DOM conformance fixture (72 assertions) now runs in real
Chromium through the same injection path a user hits. Plus a pure-function unit suite, a
suite that drives `dist/server.js` over the MCP protocol, one that exercises the real
Laya bridge on a GPU runner, and one that loads the dashboard in a browser and checks
what a person would actually see.

**Docs.** README with platform support, install, configuration reference, troubleshooting
and limits; architecture, Laya and shadow DOM guides; `CONTRIBUTING.md`, `LICENSE`,
`SECURITY.md`, and this changelog. Diagrams are Excalidraw generated from committed DSL.

### Fixed

- The in-page injection wrapper returned the walker's own completion value, so the manual
  install path never worked. Only the init-script path had ever been exercised.
- An idle timeout marked the process permanently closed, so every later tool call failed
  forever.
- `browser_status` reported `loaded: false` on a cold call that had just loaded the model.
- A failed write rendered green in the dashboard, because colour keyed off `verified`
  alone and a refusal has no `verified` value.
- Two documented environment variables were read by nothing.
- `node --test <dir>` silently ran zero tests on Node 22, the minimum supported version.
- A punctuation normalisation bug made `"email, address!"` score differently from
  `"email address"`.
- Concurrent tool calls could install the in-page layer twice on every later page.

### Known limitations

- The base Laya checkpoint is not accurate at picking web controls. It is wired as a
  shortlist generator behind a deterministic matcher, never as the decider. Measurements
  and the fine-tuning path are in `docs/laya.md`.
- Closed shadow roots are unreachable from page script, by platform design.
- Cross-origin frames are not entered; they need separate protocol-level targets.
- One page at a time. Tab management is not built.
- `LAYA_PERSISTENT_PROFILE=false` gives a throwaway profile, so every session starts
  signed out.
- The repository is private, so the documented one-line install is not yet reachable by
  anyone else.

[0.1.0]: https://github.com/joshshiman/laya-ultra-browser/releases/tag/v0.1.0
