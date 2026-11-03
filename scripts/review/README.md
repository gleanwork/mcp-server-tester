# Review loop scripts

Shell + `jq` pieces called by `.github/workflows/review-loop.yml` (untrusted, PR head) and `.github/workflows/review-gate.yml` (trusted, runs from `main`).

| Script                                     | Called by        | In                                   | Out                                                                         |
| ------------------------------------------ | ---------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `classify.sh`                              | both workflows   | changed paths on stdin, one per line | `{"category","label","file"}` on stdout                                     |
| `run-slot.sh <claude\|codex> <lens>`       | review-loop      | PR checkout, `BASE`, model key       | findings JSON on stdout, all `verified: null`                               |
| `verify-slot.sh <findings.json>`           | review-loop      | one slot's findings, `BASE`          | same JSON, `verified` and `verifiedBy` filled by the other family           |
| `model.sh <claude\|codex> <schema.json>`   | the two above    | prompt on stdin                      | `{"output","costUsd"}`: one read-only, schema-checked model call            |
| `gate.sh`                                  | review-gate      | env (see its header)                 | check run on the head SHA; `outcome=pass\|fail`, `ask=` in `$GITHUB_OUTPUT` |
| `validate-findings.sh <file> [--verified]` | all of the above | one findings file                    | exit 0, or the reasons on stderr                                            |

## Categories

`classify.sh` gives each path one category and the PR the riskiest. Riskiest first:

- `policy`: `agent-review.json`, `.github/**`, `scripts/review/**`, and files the reviewers or release process read: `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `.claude/**`, `.codex/**`, `skills/**`, `SECURITY.md`, `RELEASE.md`, `LICENSE`. A PR that can change how it is reviewed must not be auto-merged by that review.
- `security-sensitive`: `**/auth/**`, `*credential*`, `*secret*`, `*token*`.
- `feature`: anything not matched below. Also an empty PR.
- `deps-other`: `package.json`, `package-lock.json`. Patch-only detection (`deps-patch`) is not built yet.
- `tests`: `tests/**`, `*.test.*`, `*.spec.ts`, snapshots.
- `docs`: `docs/**`, `*.md`.

Only `docs` and `deps-patch` can auto-merge today.

## Findings JSON

Schema: `findings.schema.json`. One file per slot.

```json
{
  "slot": {
    "lens": "correctness",
    "runner": "claude",
    "family": "anthropic",
    "costUsd": 1.42
  },
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "file": "src/x.ts",
      "line": 42,
      "claim": "one sentence",
      "evidence": "what in the code shows it",
      "verified": null,
      "verifiedBy": null
    }
  ]
}
```

- `severity`: `blocker`, `should-fix`, or `nit`.
- `line`: `null` when the finding is about a whole file.
- `costUsd`: `null` when the CLI does not report cost.
- `verified` / `verifiedBy`: both `null` until `verify-slot.sh` runs, then both set. `verifiedBy` must be the family that did not author the slot (`anthropic` for `codex`, `openai` for `claude`).
- Every key is required and no others are allowed, so the schema works as a strict structured-output schema for both CLIs.

## Gate rules

The check passes only when all hold:

1. The `review-loop` run concluded `success`.
2. There is one valid findings file from each runner, `claude` and `codex`. A failed, missing or malformed slot is never a pass.
3. The category from `classify.sh` (rerun on `main`) is `docs` or `deps-patch`.
4. After dropping `verified: false`, no finding is `blocker` or `should-fix`.

Anything else fails the check and sends one Slack DM. `verified: null` counts as reported: an unverified finding is not dropped.

## Tests

```sh
scripts/review/test-classify.sh   # path rules
scripts/review/test-gate.sh       # gate.sh on fixtures/*, GATE_DRY_RUN=1
scripts/review/test-slots.sh      # run-slot, verify-slot, model.sh on fake CLIs
```

No API keys or network needed. Add a fixture directory under `fixtures/` for every gate rule you add. A fixture that is malformed on purpose sets `"malformed": true` in its `case.json`.
