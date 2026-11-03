#!/usr/bin/env bash
# ok/bad never fail, so `cmd && ok || bad` is a safe if/else here.
# shellcheck disable=SC2015
# Test run-slot.sh, verify-slot.sh and model.sh against fake claude/codex CLIs.
# No API keys, no network. Checks the plumbing, not the models.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# --- fake CLIs -------------------------------------------------------------
# FAKE_MODE=review|verify is decided from the prompt. FAKE_FAIL=1 makes them fail.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "$*" >"$FAKE_LOG/claude.args"
prompt="$(cat)"
[ -z "${FAKE_FAIL:-}" ] || { echo '{"type":"result","is_error":true,"subtype":"error_max_budget_usd","result":""}'; exit 0; }
if grep -q 'check each one' <<<"$prompt"; then
  out='{"verdicts":[{"id":"F1","verified":true,"reason":"real"},{"id":"F2","verified":false,"reason":"misread"}]}'
else
  out='{"findings":[{"severity":"blocker","file":"src/retry.ts","line":3,"claim":"Off by one.","evidence":"i = 1; i < n"}]}'
fi
jq -nc --argjson o "$out" '{type:"result",is_error:false,total_cost_usd:0.12,structured_output:$o}'
EOF
cat >"$tmp/bin/codex" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = login ]; then
  if [ "$2" = status ]; then [ -e "$FAKE_LOG/codex.loggedin" ]; exit; fi
  cat >"$FAKE_LOG/codex.key"; touch "$FAKE_LOG/codex.loggedin"; exit 0
fi
echo "$*" >"$FAKE_LOG/codex.args"
prompt="$(cat)"
[ -z "${FAKE_FAIL:-}" ] || { echo "boom" >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = --output-last-message ] && last="$2"; shift; done
if grep -q 'check each one' <<<"$prompt"; then
  echo '{"verdicts":[{"id":"F1","verified":false,"reason":"not reachable"}]}' >"$last"
else
  echo '{"findings":[{"severity":"should-fix","file":"README.md","line":0,"claim":"Wrong flag.","evidence":"--timeout"},{"severity":"nit","file":"src/retry.ts","line":null,"claim":"Typo.","evidence":"retyr"}]}' >"$last"
fi
EOF
chmod +x "$tmp/bin/claude" "$tmp/bin/codex"
export PATH="$tmp/bin:$PATH" FAKE_LOG="$tmp" BASE=main PR=1 OPENAI_API_KEY=sk-test

# --- a repo with origin/main and one PR commit -------------------------------
repo="$tmp/repo"
git init -q "$repo"
cd "$repo"
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git update-ref refs/remotes/origin/main HEAD
mkdir src && printf 'for (let i = 1; i < n; i++) {}\n' >src/retry.ts
git add . && git -c user.email=t@t -c user.name=t commit -q -m change

# --- run-slot ----------------------------------------------------------------
"$here/run-slot.sh" claude correctness >"$tmp/claude.json" && ok "run-slot claude exits 0" || bad "run-slot claude"
"$here/validate-findings.sh" "$tmp/claude.json" && ok "claude slot is valid" || bad "claude slot invalid"
jq -e '.slot == {lens:"correctness",runner:"claude",family:"anthropic",costUsd:0.12}
  and .findings[0].id == "F1" and .findings[0].verified == null' "$tmp/claude.json" >/dev/null \
  && ok "claude slot fields" || bad "claude slot fields: $(cat "$tmp/claude.json")"
grep -q -- '--bare' "$tmp/claude.args" && grep -q -- '--tools Read,Grep,Glob' "$tmp/claude.args" \
  && grep -q -- '--max-budget-usd 5' "$tmp/claude.args" && ok "claude is read-only, bare, capped" || bad "claude args: $(cat "$tmp/claude.args")"

"$here/run-slot.sh" codex correctness >"$tmp/codex.json" && ok "run-slot codex exits 0" || bad "run-slot codex"
jq -e '.slot.family == "openai" and .slot.costUsd == null and ([.findings[].id] == ["F1","F2"])
  and .findings[0].line == null' "$tmp/codex.json" >/dev/null \
  && ok "codex slot fields (ids, line 0 -> null, no cost)" || bad "codex slot fields: $(cat "$tmp/codex.json")"
grep -q -- '--sandbox read-only' "$tmp/codex.args" && ok "codex runs read-only" || bad "codex args: $(cat "$tmp/codex.args")"
[ "$(cat "$tmp/codex.key")" = sk-test ] && ok "codex logged in from OPENAI_API_KEY" || bad "codex login"

# --- verify-slot: claude's findings go to codex, codex's to claude -----------
"$here/verify-slot.sh" "$tmp/claude.json" >"$tmp/claude.v.json" && ok "verify claude slot exits 0" || bad "verify claude slot"
jq -e '.findings[0].verified == false and .findings[0].verifiedBy == "openai"' "$tmp/claude.v.json" >/dev/null \
  && ok "codex rejected claude's F1" || bad "claude verified: $(cat "$tmp/claude.v.json")"

"$here/verify-slot.sh" "$tmp/codex.json" >"$tmp/codex.v.json" && ok "verify codex slot exits 0" || bad "verify codex slot"
jq -e '[.findings[] | [.verified, .verifiedBy]] == [[true,"anthropic"],[false,"anthropic"]]' "$tmp/codex.v.json" >/dev/null \
  && ok "claude ruled on both codex findings" || bad "codex verified: $(cat "$tmp/codex.v.json")"

jq '.findings = []' "$tmp/claude.json" >"$tmp/empty.json"
rm -f "$tmp/codex.args"
"$here/verify-slot.sh" "$tmp/empty.json" >"$tmp/empty.v.json" && [ ! -e "$tmp/codex.args" ] \
  && ok "empty slot verified without a model call" || bad "empty slot"

# --- failures are loud ---------------------------------------------------------
if FAKE_FAIL=1 "$here/run-slot.sh" claude correctness >"$tmp/out" 2>/dev/null; then bad "claude error should fail the slot"; else ok "claude error fails the slot"; fi
[ ! -s "$tmp/out" ] && ok "failed slot prints nothing" || bad "failed slot printed output"
if FAKE_FAIL=1 "$here/run-slot.sh" codex correctness >/dev/null 2>&1; then bad "codex error should fail the slot"; else ok "codex error fails the slot"; fi
if FAKE_FAIL=1 "$here/verify-slot.sh" "$tmp/claude.json" >/dev/null 2>&1; then bad "verifier error should fail"; else ok "verifier error fails"; fi

exit "$fail"
