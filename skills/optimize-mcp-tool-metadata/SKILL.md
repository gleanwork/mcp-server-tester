---
name: optimize-mcp-tool-metadata
description: Run AI-driven tool-metadata optimization experiments for MCP servers using runVariantExperiment. Use when asked to improve tool descriptions, input schemas, or parameter descriptions, fix tool triggering, optimize tool discoverability, or run variant experiments against an eval dataset. Produces a measured, regression-guarded improvement proposal — never edits server source unless explicitly asked.
metadata:
  author: gleanwork
  version: '1.0.0'
---

# Optimize MCP Tool Metadata

Drive `runVariantExperiment` from `@gleanwork/mcp-server-tester` to find tool-metadata changes — tool descriptions, input-schema documentation, parameter descriptions — that measurably improve LLM tool triggering. You (the agent) supply the judgment — which rewrite to try next — and the library supplies the mechanism: baseline runs, variant injection, comparison, ranking, regression guarding, and a structured proposal.

## Scope: what variants can and cannot change

Overrides change what the host **sees**, not what the server **accepts**. The LLM forms tool calls against the overridden metadata, but those calls execute against the real server. Variants must stay wire-compatible:

- **Safe to vary:** the tool `description`; descriptive text inside `inputSchema` — property descriptions, enum documentation, examples, format hints.
- **Never vary:** parameter names, types, `required` arrays, or schema structure. The server still validates real calls — structural changes measure server rejections, not discoverability.
- **Out of scope entirely:** tool behavior, response shapes, auth, transport, server builds. Those need project-based A/B testing (different server configs via Playwright projects, or `runServerComparison`), which is a different workflow.

## Operating Rules

1. **Never mutate the eval dataset.** It is the behavioral contract. Variants are runtime data passed via `toolOverrides`.
2. **Never edit the MCP server source** unless the user explicitly asks for source remediation. Your deliverable is the experiment result's `proposal`.
3. **Respect the regression guard.** A variant that fixes two cases but breaks one is not a win. Leave `allowRegressions` at its default (`false`) unless the user accepts trade-offs.
4. **Mind cost.** Every candidate is a full eval run (cases × iterations × LLM calls). Prefer few, well-reasoned variants per round over shotgun spreads.

## Prerequisites

- An `mcp_host` eval dataset with `toolsTriggered` expectations (use the `write-mcp-host-eval` skill to create one).
- `npm install ai @ai-sdk/<provider>` and the matching API key env var.

## Step 1 — Establish what you're optimizing

Pick the metric before proposing anything:

| Metric          | Use when                                                             |
| --------------- | -------------------------------------------------------------------- |
| `passRate`      | General improvement across all expectations (default).               |
| `toolRecall`    | The LLM _misses_ required tools — descriptions are not discoverable. |
| `toolPrecision` | The LLM calls _extra_ tools — descriptions over-trigger or overlap.  |
| `toolF1`        | Balance both.                                                        |

Diagnose first: run the dataset once, read `caseResults[].mcpHostTrace` (calls marked `unexpected`, tools in `missed`) to see _which_ tools mis-trigger and _why_.

## Step 2 — Propose variants from evidence, not vibes

Good variant hypotheses come from failure analysis. Each maps to a metadata surface:

- **Missed triggers** (`missed` tools) → tool description: it doesn't match user vocabulary. Add concrete trigger phrasing: what the tool finds, when to use it, example asks.
- **Over-triggering** (`unexpected` calls) → tool description: too broad or overlaps a sibling tool. Add "Use this ONLY for…" scoping and explicit "do not use for…" contrast.
- **Wrong arguments** → input-schema documentation: property descriptions are vague. Describe each parameter's expected shape with an example value (text only — never change names, types, or `required`).

Each variant needs a stable `id` and a `description` of the hypothesis it tests — these flow into reports.

## Step 3 — Run the experiment

Static A/B (one round, fixed candidates):

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runVariantExperiment,
} from '@gleanwork/mcp-server-tester';

test('optimize search description', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/host-evals.json');

  const result = await runVariantExperiment(
    {
      dataset,
      metric: 'toolRecall',
      defaultLlmIterations: 10,
      variants: [
        {
          id: 'search-v2-trigger-phrases',
          description: 'Hypothesis: missed triggers due to vocabulary gap.',
          tools: {
            search: {
              description:
                'Search internal company knowledge — documents, policies, wiki pages, announcements. Use when the user asks to find, look up, or locate company information by topic.',
            },
          },
        },
      ],
    },
    { mcp, testInfo }
  );

  console.log(JSON.stringify(result.proposal, null, 2));
  expect(result.proposal?.recommendation).not.toBe('reject');
});
```

Iterative loop (you react to each round's evidence):

```typescript
const result = await runVariantExperiment(
  {
    dataset,
    metric: 'toolRecall',
    maxRounds: 4,
    minImprovement: 0.05,
    defaultLlmIterations: 10,
    async proposeVariants({ round, baseline, history, bestSoFar }) {
      const last = history.at(-1)?.best;
      const stillFailing = last?.comparison.unchangedFailures ?? [];
      const regressedAttempts = history.flatMap((r) =>
        r.candidates.filter((c) => c.disqualified)
      );
      if (round > 0 && stillFailing.length === 0) return []; // done

      // Reason over stillFailing case ids + regressedAttempts here and
      // return the next single best candidate.
      return [nextCandidate(round, bestSoFar)];
    },
  },
  { mcp, testInfo }
);
```

What the callback receives each round:

- `baseline` — the original no-override run.
- `history` — every prior round: each candidate's `result`, `comparison` (vs original baseline), `metricValue`, `metricDelta`, `disqualified`.
- `bestSoFar` — the best non-disqualified candidate yet.

Return `[]` to stop early. The runner also stops on `maxRounds` or when a round's gain is below `minImprovement`.

## Step 4 — Read the result honestly

`result.proposal.recommendation` is the verdict:

- **`apply`** — the winner improved the metric with zero regressions. Report `delta`, `improvedCaseIds`, and the exact `toolChanges`.
- **`reject`** — the best attempt regressed cases (`regressedCaseIds` says which). Report what broke; do not soft-pedal it as a partial success.
- **`inconclusive`** — nothing beat baseline. Say so plainly and propose a _different class_ of hypothesis (e.g. schema descriptions instead of tool description), or recommend expanding the dataset if failures look like dataset gaps.

Also check `result.reason`: `no-improvement` after round 1+ means your hypotheses plateaued — stop iterating rather than burning budget on rephrasings of the same idea.

## Step 5 — Deliver the proposal

Emit the final `proposal` as structured output for the user:

```json
{
  "variantId": "search-v2-trigger-phrases",
  "metric": "toolRecall",
  "baselineValue": 0.62,
  "candidateValue": 0.91,
  "delta": 0.29,
  "toolChanges": { "search": { "description": "…" } },
  "improvedCaseIds": ["find-policy", "lookup-wiki"],
  "regressedCaseIds": [],
  "recommendation": "apply"
}
```

Pair it with the human-readable summary: what changed, why it worked (tie back to the Step 2 hypothesis), the metric movement with iteration count (e.g. "+29% recall over 10 iterations/case"), and the exact replacement text the user can paste into their server.

## Checklist

- [ ] Metric chosen from observed failure mode, not defaulted blindly
- [ ] Diagnosed `mcpHostTrace` before proposing variants
- [ ] Variant `id`s are stable and `description`s state the hypothesis
- [ ] `defaultLlmIterations` >= 5 (non-determinism; 10 for decisions that matter)
- [ ] Dataset and server source untouched
- [ ] Variants are wire-compatible (descriptive text only — no renames, type, or `required` changes)
- [ ] Final answer includes the `proposal` JSON and the paste-ready metadata text
- [ ] Regressions reported plainly when present
