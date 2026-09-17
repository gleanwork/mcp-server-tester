#!/usr/bin/env bash
# Run the existing MST batch command; never source or rewrite credential files.
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The shared runner is portable; this live desktop adapter requires macOS.' >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/tsup ]]; then
  npm ci --include=dev --include=optional --include=peer
fi
if [[ -z "${MST_COWORK_PYTHON:-}" ]]; then
  export MST_COWORK_PYTHON="$ROOT/.venv/cowork-cu/bin/python"
  if [[ ! -x "$MST_COWORK_PYTHON" ]]; then
    python3 -m venv "$ROOT/.venv/cowork-cu"
    "$MST_COWORK_PYTHON" -m pip install -r scripts/cowork-requirements.txt
  fi
fi
export MST_COWORK_DRIVER_ROOT="$ROOT"
npm run build
has_manifest=false
for arg in "$@"; do
  case "$arg" in
    --manifests|--manifests=*|--manifest-dir|--manifest-dir=*) has_manifest=true;;
  esac
done
if [[ "$has_manifest" == false ]]; then
  set -- --manifests configs/cowork-smoke.json "$@"
fi
# Node parses dotenv as data, not shell code. This also supplies custom judges.
if [[ -n "${COWORK_ENV_FILE:-}" ]]; then
  exec node --env-file="$COWORK_ENV_FILE" dist/cli/index.js batch --workers 1 --output-root .mcp-test-results/cowork "$@"
fi
exec node dist/cli/index.js batch --workers 1 --output-root .mcp-test-results/cowork "$@"
