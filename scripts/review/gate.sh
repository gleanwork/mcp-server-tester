#!/usr/bin/env bash
# Decide one PR and publish the required check. Runs in review-gate.yml from main.
#
# Env in:
#   PR, HEAD_SHA, REPO, CHECK_NAME
#   REVIEW_CONCLUSION  review-loop's conclusion (success | failure | ...)
#   CLASSIFICATION     path to classify.sh output, computed from main's rules
#   FINDINGS_DIR       dir of verify-slot.sh outputs (may be missing)
#   DETAILS_URL        optional link for the check (the review-loop run)
#   GH_TOKEN           GITHUB_TOKEN with checks: write
#   GATE_DRY_RUN=1     print the check instead of publishing it
#   GITHUB_OUTPUT      receives outcome=pass|fail and ask=<one line>
#
# Pass only when all hold:
#   1. review-loop concluded success
#   2. one valid findings file from each runner (claude, codex)
#   3. the category is docs or deps-patch
#   4. no blocker/should-fix left after dropping verified:false
set -euo pipefail

: "${PR:?}" "${HEAD_SHA:?}" "${REPO:?}" "${CHECK_NAME:?}" "${REVIEW_CONCLUSION:?}"
: "${CLASSIFICATION:?}" "${FINDINGS_DIR:?}" "${GITHUB_OUTPUT:?}"

here="$(cd "$(dirname "$0")" && pwd)"
auto_merge_categories='["docs","deps-patch"]'
required_runners='["claude","codex"]'

category="$(jq -r '.category' "$CLASSIFICATION")"
category_file="$(jq -r '.file // ""' "$CLASSIFICATION")"

# Collect the slots. A malformed file is a failed slot, never silently skipped.
slots='[]'
problems=()
shopt -s nullglob
for f in "$FINDINGS_DIR"/*.json; do
  if errs="$("$here/validate-findings.sh" "$f" 2>&1)"; then
    slots="$(jq -c --slurpfile s "$f" '. + $s' <<<"$slots")"
  else
    problems+=("$(basename "$f") is malformed: $(head -1 <<<"$errs")")
  fi
done
shopt -u nullglob

missing="$(jq -r --argjson want "$required_runners" \
  '$want - [.[].slot.runner] | join(", ")' <<<"$slots")"
[ -z "$missing" ] || problems+=("no review from: $missing")

# Reported = everything the other family did not reject.
reported="$(jq -c '[.[] | .slot as $s | .findings[]
  | select(.verified != false) | . + {runner: $s.runner}]' <<<"$slots")"
dropped="$(jq '[.[].findings[] | select(.verified == false)] | length' <<<"$slots")"
blocking="$(jq -c '[.[] | select(.severity == "blocker" or .severity == "should-fix")]' <<<"$reported")"
n_blocking="$(jq 'length' <<<"$blocking")"
cost="$(jq '[.[].slot.costUsd // 0] | add // 0 | . * 100 | round / 100' <<<"$slots")"

# Decide, most fundamental reason first. The ask is one line for the Slack DM.
if [ "$REVIEW_CONCLUSION" != "success" ]; then
  outcome=fail
  title="Review did not finish ($REVIEW_CONCLUSION)"
  ask="PR #$PR: the review did not finish ($REVIEW_CONCLUSION). Re-run review-loop or review it yourself."
elif [ "${#problems[@]}" -gt 0 ]; then
  outcome=fail
  title="Review incomplete"
  ask="PR #$PR: the review is incomplete (${problems[0]}). Re-run review-loop or review it yourself."
elif [ "$n_blocking" -gt 0 ]; then
  outcome=fail
  title="$n_blocking problem(s) not dismissed by the other reviewer"
  first="$(jq -r '.[0] | "\(.file)\(if .line then ":\(.line)" else "" end) \(.claim)"' <<<"$blocking")"
  ask="PR #$PR: $n_blocking problem(s) not dismissed by the other reviewer. First: $first Fix it or reply on the PR."
elif ! jq -e --arg c "$category" 'index($c)' <<<"$auto_merge_categories" >/dev/null; then
  outcome=fail
  title="Needs a person: $category"
  ask="PR #$PR is '$category' (${category_file:-no files}), which always needs a person. The review found nothing blocking: approve and merge if it is what you intended."
else
  outcome=pass
  title="Clean $category change: auto-merge"
  ask=""
fi

# One line, so it is safe in $GITHUB_OUTPUT and Slack.
ask="$(tr '\n\r' '  ' <<<"$ask" | sed 's/  */ /g; s/ $//')"

summary="$(jq -rn \
  --arg outcome "$outcome" --arg category "$category" --arg file "$category_file" \
  --arg review "$REVIEW_CONCLUSION" --argjson reported "$reported" \
  --argjson dropped "$dropped" --argjson cost "$cost" --arg ask "$ask" \
  --arg problems "$(printf '%s\n' "${problems[@]+"${problems[@]}"}")" '
  [
    "**Outcome:** \($outcome)",
    "**Category:** `\($category)`" + (if $file != "" then " (from `\($file)`)" else "" end),
    "**review-loop:** \($review)",
    "**Cost:** $\($cost)",
    (if $ask != "" then "\n**Ask:** \($ask)" else empty end),
    (if $problems != "" then "\n**Problems:**\n" + ($problems | rtrimstr("\n") | split("\n") | map("- " + .) | join("\n")) else empty end),
    "\n### Findings (\($reported | length) reported, \($dropped) dropped by the other family)",
    (if ($reported | length) == 0 then "None." else
      ($reported[] | "- **\(.severity)** `\(.file)\(if .line then ":\(.line)" else "" end)` (\(.runner), verified: \(.verified)): \(.claim)")
    end)
  ] | join("\n")')"

payload="$(jq -n \
  --arg name "$CHECK_NAME" --arg sha "$HEAD_SHA" --arg url "${DETAILS_URL:-}" \
  --arg conclusion "$([ "$outcome" = pass ] && echo success || echo failure)" \
  --arg title "$title" --arg summary "$summary" '
  {name: $name, head_sha: $sha, status: "completed", conclusion: $conclusion,
   output: {title: $title, summary: $summary}}
  + (if $url != "" then {details_url: $url} else {} end)')"

if [ "${GATE_DRY_RUN:-}" = 1 ]; then
  echo "$payload"
else
  gh api -X POST "repos/$REPO/check-runs" --input - <<<"$payload" >/dev/null
fi

{
  echo "outcome=$outcome"
  echo "ask=$ask"
} >>"$GITHUB_OUTPUT"

echo "$outcome: $title" >&2
