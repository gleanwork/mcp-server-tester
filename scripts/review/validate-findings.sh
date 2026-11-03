#!/usr/bin/env bash
# Validate one findings file against the shape in findings.schema.json.
#
#   scripts/review/validate-findings.sh <findings.json> [--verified]
#
# Exit 0 when valid, 1 with the reasons on stderr when not.
# --verified also requires every finding to carry a verdict from the family
# that did NOT author the slot (what the gate expects after verify-slot.sh).
#
# jq only, so it runs anywhere the workflows run. Keep it in step with
# findings.schema.json by hand; the shape is small on purpose.
set -euo pipefail

file="${1:?usage: validate-findings.sh <findings.json> [--verified]}"
require_verified="${2:-}"

errors=$(jq -r --arg rv "$require_verified" '
  def keys_exactly($want):
    (keys - $want | map("unexpected key " + .)) +
    ($want - keys | map("missing key " + .));
  def family_of($r):
    if $r == "claude" then "anthropic" elif $r == "codex" then "openai" else null end;

  if type != "object" then ["root must be an object"]
  else
    keys_exactly(["findings", "slot"])
    + (if (.slot | type) != "object" then ["slot must be an object"]
       else
         (.slot | keys_exactly(["costUsd", "family", "lens", "runner"]) | map("slot: " + .))
         + (if .slot.lens != "correctness" then ["slot.lens must be correctness"] else [] end)
         + (if (.slot.runner | IN("claude", "codex")) | not then ["slot.runner must be claude|codex"] else [] end)
         + (if .slot.family != family_of(.slot.runner) then ["slot.family does not match slot.runner"] else [] end)
         + (if (.slot.costUsd | type) as $t | ($t == "number" and .slot.costUsd >= 0) or $t == "null" | not
            then ["slot.costUsd must be a number >= 0 or null"] else [] end)
       end)
    + (if (.findings | type) != "array" then ["findings must be an array"]
       else
         .slot.family as $author
         | ([.findings[].id] | group_by(.) | map(select(length > 1) | "duplicate id " + .[0]))
         + [.findings | to_entries[] | .key as $i | .value as $f | "findings[\($i)]: " as $p
            | if ($f | type) != "object" then $p + "must be an object"
              else
                (($f | keys_exactly(["claim", "evidence", "file", "id", "line", "severity", "verified", "verifiedBy"]))[] | $p + .),
                (if ($f.id | type) != "string" or ($f.id | test("^F[0-9]+$") | not) then $p + "id must match F<n>" else empty end),
                (if ($f.severity | IN("blocker", "should-fix", "nit")) | not then $p + "severity must be blocker|should-fix|nit" else empty end),
                (if ($f.file | type) != "string" or $f.file == "" then $p + "file must be a non-empty string" else empty end),
                (if $f.line != null and (($f.line | type) != "number" or $f.line < 1 or $f.line != ($f.line | floor)) then $p + "line must be an integer >= 1 or null" else empty end),
                (if ($f.claim | type) != "string" or $f.claim == "" then $p + "claim must be a non-empty string" else empty end),
                (if ($f.evidence | type) != "string" then $p + "evidence must be a string" else empty end),
                (if ($f.verified | type) | IN("boolean", "null") | not then $p + "verified must be true|false|null" else empty end),
                (if $f.verifiedBy | IN("anthropic", "openai", null) | not then $p + "verifiedBy must be anthropic|openai|null" else empty end),
                (if ($f.verified == null) != ($f.verifiedBy == null) then $p + "verified and verifiedBy must be set together" else empty end),
                (if $f.verifiedBy != null and $f.verifiedBy == $author then $p + "verifiedBy must differ from slot.family" else empty end),
                (if $rv == "--verified" and $f.verified == null then $p + "not verified" else empty end)
              end]
       end)
  end
  | .[]
' "$file" 2>&1) || { echo "$file: invalid: $errors" >&2; exit 1; }

if [ -n "$errors" ]; then
  while IFS= read -r line; do echo "$file: $line" >&2; done <<<"$errors"
  exit 1
fi
