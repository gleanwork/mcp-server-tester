#!/usr/bin/env bash
# Classify a PR by the paths it changes.
#
#   git diff --name-only origin/main...HEAD | scripts/review/classify.sh
#   {"category":"docs","label":"review:docs","file":"README.md"}
#
# Each path gets one category; the PR gets the riskiest one, and "file" names
# the first path that set it. Path rules only: no model, no network, so the
# gate can rerun it from main on GitHub's file list and get the same answer.
#
# Riskiest first:
#   policy              the loop itself, and files that instruct the reviewers
#   security-sensitive  auth, credentials, tokens, secrets
#   feature             anything not matched below (the safe default)
#   deps-other          package manifests (patch-only detection is not built)
#   tests               test files only
#   docs                prose only
set -euo pipefail

rank() {
  case "$1" in
    policy) echo 6 ;;
    security-sensitive) echo 5 ;;
    feature) echo 4 ;;
    deps-other) echo 3 ;;
    tests) echo 2 ;;
    docs) echo 1 ;;
  esac
}

category_of() {
  case "$1" in
    # The loop's own code and policy. A PR must never approve its own gate.
    agent-review.json | .github/* | scripts/review/*) echo policy ;;
    # Read by the reviewers or by people deciding releases and security.
    AGENTS.md | */AGENTS.md | CLAUDE.md | */CLAUDE.md | REVIEW.md | \
      .claude/* | .codex/* | skills/* | SECURITY.md | RELEASE.md | LICENSE) echo policy ;;

    */auth/* | auth/* | *credential* | *secret* | *token*) echo security-sensitive ;;

    package.json | */package.json | package-lock.json | */package-lock.json) echo deps-other ;;

    tests/* | *.test.ts | *.test.tsx | *.test.mjs | *.spec.ts | *-snapshots/*) echo tests ;;

    docs/* | *.md) echo docs ;;

    *) echo feature ;;
  esac
}

best=""
best_rank=0
best_file=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  c="$(category_of "$path")"
  r="$(rank "$c")"
  if [ "$r" -gt "$best_rank" ]; then
    best="$c" best_rank="$r" best_file="$path"
  fi
done

# No files (e.g. an empty PR): nothing proves it is safe.
if [ -z "$best" ]; then
  best=feature best_file=""
fi

jq -nc --arg c "$best" --arg f "$best_file" \
  '{category: $c, label: ("review:" + $c), file: $f}'
