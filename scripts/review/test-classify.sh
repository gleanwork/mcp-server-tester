#!/usr/bin/env bash
# Table tests for classify.sh: changed paths (comma-separated) -> category.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fail=0

check() {
  local want="$1" paths="$2" got
  got="$(tr ',' '\n' <<<"$paths" | "$here/classify.sh" | jq -r '.category')"
  if [ "$got" = "$want" ]; then
    echo "ok   $want <- $paths"
  else
    echo "FAIL $paths: expected $want, got $got"
    fail=1
  fi
}

check docs "README.md"
check docs "docs/cli.md,docs/design/auth-and-connectors.md"
check docs "CHANGELOG.md,CONTRIBUTING.md"
check tests "tests/foo.test.ts,README.md"
check tests "src/x.test.ts"
check feature "src/cli/index.ts"
check feature "src/cli/index.ts,README.md,tests/a.test.ts"
check feature "schema/run.json"
check feature ""
check deps-other "package.json,package-lock.json"
check feature "package.json,src/a.ts"
check security-sensitive "src/auth/cli.ts"
check security-sensitive "snippets/auth-static-token-config.ts"
check security-sensitive "docker/cowork-linux/bin/inference-token"
check policy ".github/workflows/ci.yml"
check policy "agent-review.json"
check policy "scripts/review/gate.sh"
check policy "README.md,CLAUDE.md"
check policy "AGENTS.md"
check policy "REVIEW.md"
check policy "skills/foo/SKILL.md"
check policy ".claude/settings.json"
check policy "SECURITY.md"
check policy "src/auth/cli.ts,.github/CODEOWNERS"

# Output shape
out="$(printf 'docs/a.md\nsrc/b.ts\n' | "$here/classify.sh")"
if jq -e '. == {category: "feature", label: "review:feature", file: "src/b.ts"}' <<<"$out" >/dev/null; then
  echo "ok   output shape"
else
  echo "FAIL output shape: $out"
  fail=1
fi

exit "$fail"
