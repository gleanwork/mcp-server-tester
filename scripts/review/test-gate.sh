#!/usr/bin/env bash
# Run gate.sh against every fixture and compare its outcome with case.json.
#
#   scripts/review/test-gate.sh
#
# Each fixtures/<case>/ holds what review-gate.yml hands gate.sh:
#   case.json            {about, reviewConclusion, expect: pass|fail}
#   classification.json  classify.sh output
#   verified/*.json      verify-slot.sh output (absent when the review failed)
#
# gate.sh must honour GATE_DRY_RUN=1: decide, print the check it would
# publish, write outcome/ask to $GITHUB_OUTPUT, and make no gh api calls.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# Fixtures must themselves be valid, or the gate tests prove nothing.
for f in "$here"/fixtures/*/verified/*.json; do
  "$here/validate-findings.sh" "$f" --verified || fail=1
done

for dir in "$here"/fixtures/*/; do
  name="$(basename "$dir")"
  expect="$(jq -r '.expect' "$dir/case.json")"
  out="$(mktemp)"

  if GATE_DRY_RUN=1 \
    PR=1 HEAD_SHA=0000000000000000000000000000000000000000 \
    REPO=gleanwork/mcp-server-tester CHECK_NAME="review-loop / eligibility" \
    REVIEW_CONCLUSION="$(jq -r '.reviewConclusion' "$dir/case.json")" \
    CLASSIFICATION="$dir/classification.json" \
    FINDINGS_DIR="$dir/verified" \
    GITHUB_OUTPUT="$out" \
    "$here/gate.sh" >/dev/null; then
    got="$(sed -n 's/^outcome=//p' "$out")"
  else
    got="error (exit $?)"
  fi
  rm -f "$out"

  if [ "$got" = "$expect" ]; then
    echo "ok   $name ($got)"
  else
    echo "FAIL $name: expected $expect, got ${got:-nothing}"
    fail=1
  fi
done

exit "$fail"
