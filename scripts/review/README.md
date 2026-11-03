# Review loop scripts

Shell + `jq` pieces called by `.github/workflows/review-loop.yml` (untrusted, PR head) and `.github/workflows/review-gate.yml` (trusted, runs from `main`).

| Script                                     | Called by        | In                                        | Out                                                                         |
| ------------------------------------------ | ---------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `classify.sh`                              | both workflows   | changed paths on stdin, one per line      | `{"category","label"}` on stdout                                            |
| `run-slot.sh <claude\|codex> <lens>`       | review-loop      | PR checkout, `BASE`, `PR`, model key      | findings JSON on stdout, all `verified: null`                               |
| `verify-slot.sh <findings.json>`           | review-loop      | one slot's findings                       | same JSON, `verified` and `verifiedBy` filled by the other family           |
| `gate.sh`                                  | review-gate      | env (see the header of `review-gate.yml`) | check run on the head SHA; `outcome=pass\|fail`, `ask=` in `$GITHUB_OUTPUT` |
| `validate-findings.sh <file> [--verified]` | any of the above | one findings file                         | exit 0, or the reasons on stderr                                            |
| `test-gate.sh`                             | people           | `fixtures/*`                              | `ok`/`FAIL` per fixture                                                     |

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

1. The `review-loop` run concluded `success`. A failed or missing slot is never a pass.
2. The category from `classify.sh` (rerun on `main`) is `docs` or `deps-patch`.
3. After dropping `verified: false`, no finding is `blocker` or `should-fix`.

Anything else fails the check and sends one Slack DM. `verified: null` counts as reported: an unverified finding is not dropped.

## Testing the gate

```sh
scripts/review/test-gate.sh
```

`gate.sh` must support `GATE_DRY_RUN=1` (decide and write outputs, no `gh api` calls). Add a fixture directory for every rule you add.
