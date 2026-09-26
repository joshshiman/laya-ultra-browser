#!/usr/bin/env bash
#
# Creates an isolated environment for local Laya ranking and verifies it.
#
# Uses uv rather than python -m venv because uv resolves the interpreter, creates the
# environment, and installs into it in one step, and can pin a Python version so the
# result does not depend on whatever python3 happens to be first on PATH.
#
# Deliberately does not touch any system or pyenv Python. Everything lives under
# ~/.laya-ultra-browser, which the MCP server finds on its own.
#
# Usage:
#   scripts/setup-laya.sh            create or update the environment
#   scripts/setup-laya.sh --check    report status without changing anything
#
set -euo pipefail

ROOT="${LAYA_HOME:-$HOME/.laya-ultra-browser}"
VENV="$ROOT/venv"
PYTHON_VERSION="${LAYA_PYTHON_VERSION:-3.12}"
MODEL="${LAYA_MODEL:-convaiinnovations/laya}"
CHECKPOINT="${LAYA_CHECKPOINT:-}"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

if ! command -v uv >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: uv is required but not installed.

Install it with either:

  curl -LsSf https://astral.sh/uv/install.sh | sh

or, if you prefer homebrew:

  brew install uv
EOF
  exit 1
fi

step "Environment"
say "root:    $ROOT"
say "python:  $PYTHON_VERSION (uv managed)"
say "model:   $MODEL${CHECKPOINT:+/$CHECKPOINT}"
say "check:   $(uv --version)"

if [ "$CHECK_ONLY" -eq 1 ]; then
  step "Status"
  if [ ! -x "$VENV/bin/python" ]; then
    say "not created. Run: scripts/setup-laya.sh"
    exit 1
  fi
  say "python:  $("$VENV/bin/python" -V 2>&1)"
  if "$VENV/bin/python" -c "import laya_mlx" 2>/dev/null; then
    say "laya_mlx: $("$VENV/bin/python" -c 'import laya_mlx; print(laya_mlx.__version__)')"
  else
    say "laya_mlx: NOT installed"
    exit 1
  fi
  exit 0
fi

step "Creating the environment"
if [ ! -x "$VENV/bin/python" ]; then
  # uv downloads a managed CPython if the requested version is not already present, so
  # this does not depend on any python3 the user happens to have.
  uv venv --python "$PYTHON_VERSION" "$VENV"
else
  say "reusing existing environment at $VENV"
fi

step "Installing Laya"
# mlx first so its Metal binary is present before laya-mlx resolves against it.
uv pip install --python "$VENV/bin/python" mlx
uv pip install --python "$VENV/bin/python" laya-mlx

step "Verifying"
"$VENV/bin/python" - <<'PY'
import sys
print(f"  python:   {sys.version.split()[0]}")
import mlx.core as mx
print(f"  mlx:      {mx.__version__} on {mx.default_device()}")
import laya_mlx
print(f"  laya_mlx: {laya_mlx.__version__}")
PY

step "Warming the model"
say "first run downloads the checkpoint, roughly 2GB, and can take a few minutes"
if [ -z "${HF_TOKEN:-}" ]; then
  say "no HF_TOKEN set, so the download is unauthenticated and may hit a rate limit."
  say "export HF_TOKEN=... before running this if that happens."
fi
LAYA_MODEL="$MODEL" LAYA_CHECKPOINT="$CHECKPOINT" \
  "$VENV/bin/python" - "$MODEL" "$CHECKPOINT" <<'PY'
import sys
import laya_mlx

model, checkpoint = sys.argv[1], sys.argv[2] or None
agent = laya_mlx.load(model, subfolder=checkpoint, dtype="float16", device="gpu")
print(f"  loaded {model}{'/' + checkpoint if checkpoint else ''}")
print(f"  context: {agent.cfg.get('max_len')} tokens, option head {agent.cfg.get('head_max_len')}")
print("  ready")
PY

cat <<EOF

Done. The MCP server finds this environment automatically at:
  $VENV/bin/python

To point it somewhere else, set LAYA_PYTHON.

Next: add the server to your MCP client. See the README for the config block.
EOF
