#!/usr/bin/env bash
# Run the existing MST batch command; never source or rewrite credential files.
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
has_config=false
for arg in "$@"; do
  case "$arg" in
    --configs|--configs=*|--config-dir|--config-dir=*) has_config=true;;
  esac
done
if [[ "$has_config" == false ]]; then
  echo 'Provide --configs <path> or --config-dir <directory>; no default eval is bundled.' >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The shared runner is portable; this live desktop adapter requires macOS.' >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/tsup ]]; then
  npm ci --include=dev --include=optional --include=peer
fi
npm run build
# Node parses dotenv as data, not shell code. This also supplies custom judges.
if [[ -n "${COWORK_ENV_FILE:-}" ]]; then
  exec node --env-file="$COWORK_ENV_FILE" dist/cli/index.js batch --workers 1 --output-root .mcp-test-results/cowork "$@"
fi
exec node dist/cli/index.js batch --workers 1 --output-root .mcp-test-results/cowork "$@"
