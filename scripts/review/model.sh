#!/usr/bin/env bash
# Run one headless, read-only model call with a structured-output schema.
#
#   scripts/review/model.sh <claude|codex> <schema.json> < prompt.txt
#   {"output": {...matches schema...}, "costUsd": 0.42}
#
# The model works in the current directory (the PR checkout) with read-only
# tools only: claude gets Read/Grep/Glob, codex runs in its read-only sandbox.
# Exit non-zero on any failure; the caller marks the slot failed.
#
# Env: ANTHROPIC_API_KEY (claude), OPENAI_API_KEY (codex),
#      MAX_COST_USD (claude budget, default 5), MODEL_TIMEOUT (seconds, default 900),
#      CLAUDE_MODEL / CODEX_MODEL (optional overrides).
set -euo pipefail

runner="${1:?usage: model.sh <claude|codex> <schema.json> < prompt}"
schema="${2:?usage: model.sh <claude|codex> <schema.json> < prompt}"
max_cost="${MAX_COST_USD:-5}"
time_limit="${MODEL_TIMEOUT:-900}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat >"$work/prompt.txt"

with_timeout() {
  if command -v timeout >/dev/null; then timeout "$time_limit" "$@"; else "$@"; fi
}

case "$runner" in
  claude)
    # shellcheck disable=SC2054 # the commas are part of the tool list
    args=(-p --bare --output-format json
      --json-schema "$(jq -c . "$schema")"
      --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
      --permission-mode dontAsk
      --max-budget-usd "$max_cost"
      --no-session-persistence)
    [ -z "${CLAUDE_MODEL:-}" ] || args+=(--model "$CLAUDE_MODEL")
    with_timeout claude "${args[@]}" <"$work/prompt.txt" >"$work/result.json"

    if jq -e '.is_error == true' "$work/result.json" >/dev/null; then
      echo "claude reported an error: $(jq -c '{subtype, result}' "$work/result.json")" >&2
      exit 1
    fi
    # Structured output lands in .structured_output; fall back to parsing .result.
    jq -c '{
      output: (.structured_output // (.result | fromjson)),
      costUsd: (.total_cost_usd // null)
    }' "$work/result.json"
    ;;

  codex)
    # codex reads its key from its own login store, not the environment.
    if [ -n "${OPENAI_API_KEY:-}" ]; then
      printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
    fi
    args=(exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules
      --color never --output-schema "$schema"
      --output-last-message "$work/last.json")
    [ -z "${CODEX_MODEL:-}" ] || args+=(--model "$CODEX_MODEL")
    with_timeout codex "${args[@]}" - <"$work/prompt.txt" >"$work/log.txt" 2>&1 || {
      echo "codex exec failed:" >&2
      tail -20 "$work/log.txt" >&2
      exit 1
    }
    # codex reports tokens, not dollars.
    jq -c '{output: ., costUsd: null}' "$work/last.json"
    ;;

  *)
    echo "unknown runner: $runner" >&2
    exit 2
    ;;
esac
