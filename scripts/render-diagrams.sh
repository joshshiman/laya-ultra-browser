#!/usr/bin/env bash
#
# Regenerates the diagrams in docs/ from the DSL sources in docs/diagrams/.
#
# The renderer is a build-time tool only and is deliberately not a dependency of the
# package: it pulls in jsdom and a native rasteriser, none of which anyone needs to
# run the MCP server. It is invoked through npx so a contributor regenerating a
# diagram does not have to install anything permanently.
#
#   npm run diagrams
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${EXCALIDRAW_CLI:-@swiftlysingh/excalidraw-cli}"

say() { printf '  %s\n' "$*"; }

render() {
  local name="$1" scale="$2"
  say "rendering $name"
  npx --yes "$CLI" create "$ROOT/docs/diagrams/$name.dsl" \
    -o "$ROOT/docs/diagrams/$name.excalidraw" >/dev/null
  npx --yes "$CLI" convert "$ROOT/docs/diagrams/$name.excalidraw" \
    --format png --scale "$scale" -o "$ROOT/docs/$name.png" >/dev/null
  # Drop the intermediate, which is only useful for editing in excalidraw.com.
  rm -f "$ROOT/docs/diagrams/$name.excalidraw"
}

# Scale 2 so the sketch lines survive being scaled down to README width.
render hero 2
render architecture 1.5

say "done:"
ls -la "$ROOT/docs/flow.png" "$ROOT/docs/architecture.png"
