---
name: optimize-mcp-tool-metadata
description: Improve an MCP server's tool metadata (tool names, descriptions, input schema descriptions) with measured evidence, using runToolOptimization from @gleanwork/mcp-server-tester/evals or `mst run` with tool-metadata variants. Use when asked to improve tool descriptions, fix tools a model misses or over-uses, optimize tool discoverability, or compare description rewrites. Produces a recommendation with the exact metadata to apply; never edits the server or the dataset unless asked.
metadata:
  author: gleanwork
  version: '2.0.0'
---

# Optimize MCP tool metadata

A tool optimization runs tool-metadata variants against a baseline and recommends applying one or none. Each variant shows the client different tool names, descriptions or input schemas; the cases, servers, client and model stay the same. You decide which rewrites to try. MST runs the trials, compares each variant with the baseline case by case, guards the cases that work today, and returns a proposal.

## Rules

1. **Don't edit the dataset.** It defines what good behaviour is. Variants are data passed to the run.
2. **Don't edit the server source** unless the user asks. Deliver the proposal and the text to paste.
3. **Respect the regression guard.** A variant that fixes two cases and breaks one isn't a win. Leave `allowRegressions` off unless the user accepts the trade.
4. **Mind cost.** Every variant is a full run: cases × trials × a model conversation each. Try a few variants built on evidence, not many guesses.

## What a variant can change

Tool metadata changes what the client sees, not what the server accepts. The model forms calls against the variant's metadata, and the calls run on the real server.

- **Change freely:** a tool's `description`; descriptive text in its `inputSchema` (property descriptions, enum documentation, examples, format hints).
- **Rename with care:** `name` gives the tool a new name. Calls reach the original tool and are recorded under the original name, so assertions don't change. The server keeps its own name until someone changes it.
- **Never change:** parameter names, types, `required`, or schema structure. The server still validates real calls, so the run would measure rejected calls, not discoverability.
- **Out of scope:** tool behaviour, response shapes, auth or a different server build. Compare those as variants with different `servers` (see `write-mcp-eval`).

## Prerequisites

- A dataset of cases with `toolsTriggered` assertions (the `write-mcp-eval` skill). Several phrasings per tool, and inputs that should not trigger it.
- Cases that work today and must keep working tagged `regression`. Without the tag, MST runs the baseline one extra time to find them.
- Optionally, a few cases tagged `held-out`. They don't count toward ranking and your proposals never see them, so their result shows whether the winner generalizes.
- An API key for the model (`ANTHROPIC_API_KEY` for `claude-*` models on the `mst` client).

## Step 1: Pick the metric and diagnose

| Metric          | Use when                                                        |
| --------------- | --------------------------------------------------------------- |
| `passRate`      | Overall improvement on every assertion (default)                |
| `toolRecall`    | The model misses required tools                                 |
| `toolPrecision` | The model calls extra tools: descriptions overlap or over-reach |
| `toolF1`        | Both                                                            |

Run the baseline once (a `runEvalDataset` test, or `mst run`) and read each failing case's `toolCallTrace`: `calls` marked `unexpected`, and `missed` tools. Note which tools fail, on which inputs, and what the model called instead.

## Step 2: Write variants from the evidence

| Failure                                   | Change                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A tool is `missed`                        | Its description doesn't match how users ask. Say what it finds and when to use it, with example requests       |
| Calls are `unexpected`                    | A description is too broad or overlaps a sibling. Add "Use only for …" and "Don't use for …; use `other_tool`" |
| Wrong arguments                           | Parameter descriptions are vague. Describe the expected value with an example (text only)                      |
| The name misleads (`do_query` for search) | Try a `name` that says what it does                                                                            |

Each variant is a `ToolOverrideVariant`: a unique `id`, a `description` stating the hypothesis, and `tools`, keyed by the tool's name on its server (`"server.tool"` when several servers have it). The id and description appear in the report.

## Step 3: Run the optimization

### On the `mst` client, in a Playwright test

The dataset form runs on the `mst` client over the test's MCP connection. It takes a `model`; it doesn't take `clientOptions`.

```typescript
// tests/optimize-search.spec.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  type ToolOverrideVariant,
} from '@gleanwork/mcp-server-tester';
import { runToolOptimization } from '@gleanwork/mcp-server-tester/evals';

const variants: ToolOverrideVariant[] = [
  {
    id: 'search-trigger-phrases',
    description: 'Missed triggers: the description lacks the words users use.',
    tools: {
      search: {
        description:
          'Search internal company knowledge: documents, policies, wiki pages and announcements. Use it when the user asks to find, look up or locate company information by topic.',
      },
    },
  },
];

test('optimize search metadata', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./evals/search-evals.json');
  const result = await runToolOptimization(
    {
      dataset,
      variants,
      metric: 'toolRecall',
      model: 'claude-haiku-4-5',
      defaultTrials: 10,
    },
    { mcp, testInfo }
  );
  console.log(JSON.stringify(result.proposal, null, 2));
  expect(result.winner?.measurement.brokenCaseIds ?? []).toHaveLength(0);
});
```

With `testInfo`, the MCP reporter opens on a Comparison tab: the recommendation, each variant against the baseline, and every case and trial.

To try rewrites round by round, pass `proposeVariants` instead of (or after) `variants`:

```typescript
const result = await runToolOptimization(
  {
    dataset,
    metric: 'toolRecall',
    model: 'claude-haiku-4-5',
    defaultTrials: 10,
    maxRounds: 4,
    minImprovement: 0.05,
    async proposeVariants({ round, baseline, history, bestSoFar }) {
      const last = history.at(-1)?.best;
      const stillFailing =
        last?.comparison.unchangedFailures.map((c) => c.id) ?? [];
      if (round > 0 && stillFailing.length === 0) return [];
      // Read baseline, history and bestSoFar, then return the next one or two variants.
      return [nextVariant(round, bestSoFar)];
    },
  },
  { mcp, testInfo }
);
```

The callback receives `round`, `baseline` (the run without variants), `metric`, `history` (each round's candidates with `result`, `comparison` against the baseline, `metricValue`, `metricDelta`, `measurement`, `fixes` and `disqualified`) and `bestSoFar`. Held-out cases are removed from all of it. Return `[]` to stop. The optimization also stops after `maxRounds`, or when a round improves on the best so far by less than `minImprovement`.

### On any client, from an eval config

Give `runToolOptimization` an eval config to run the variants on the config's client and model (`claude-code`, `cowork`, a plugin client, or `mst` with `clientOptions`), and to optimize any numeric variant metric. Each candidate runs as a copy of `baseVariant` (default: the config's baseline) with the candidate's `tools`. `chatgpt` can't show tool metadata.

```typescript
// scripts/optimize-search.ts
import { runToolOptimization } from '@gleanwork/mcp-server-tester/evals';

const result = await runToolOptimization({
  evalConfig: { configPath: './evals/eval.json' },
  variants,
  metric: 'passRate', // or trialPassRate, or a variant metric such as input_tokens_mean
  better: 'higher', // 'lower' for tokens, cost or time
});
console.log(JSON.stringify(result.proposal, null, 2));
```

Run it with `npx tsx scripts/optimize-search.ts`. Each run is stored like any other run of the eval config.

### Without a recommendation: `mst run` with variants

For a quick side-by-side, put the rewrites in an eval config as variants and run it:

```json
{
  "name": "search-descriptions",
  "datasets": ["./search-evals.json"],
  "servers": {
    "docs": {
      "transport": "stdio",
      "command": "node",
      "args": ["./dist/server.js"]
    }
  },
  "client": "mst",
  "model": "claude-haiku-4-5",
  "trials": 10,
  "variants": [
    { "name": "current" },
    {
      "name": "search-trigger-phrases",
      "description": "Missed triggers: the description lacks the words users use.",
      "tools": {
        "search": {
          "description": "Search internal company knowledge: documents, policies, wiki pages and announcements. Use it when the user asks to find, look up or locate company information by topic."
        }
      }
    }
  ]
}
```

```bash
npx mst run --config evals/search-descriptions.json --dry-run
npx mst run --config evals/search-descriptions.json
```

`mst run` prints each variant's metrics and its change from the baseline (the first variant), but no significance test and no regression guard. Use `runToolOptimization` before recommending a change.

## Step 4: Read the result

`result.proposal.recommendation`:

- **`apply`**: the winner is clearly better than the baseline and broke no regression cases. "Clearly" means a paired per-case test passed at p < 0.025 divided by the number of variants tried, so trying many variants can't promote a lucky one. Report `delta`, `improvedCaseIds` and the exact `toolChanges`.
- **`reject`**: no variant qualified, and the best one tried broke cases (`regressedCaseIds`, and `measurement.brokenCaseIds` on the candidate). Say what broke. Don't present it as a partial success.
- **`inconclusive`**: nothing was clearly better. Small datasets and few trials end here often. Run more trials (10 or more), add cases, or try a different kind of change (parameter descriptions instead of the tool description).

Also read `result.reason`: `no-improvement` after a later round means the rewrites have plateaued, so stop rather than spend more on rephrasing the same idea. One flaky trial on a regression case doesn't count as breakage; a case or group that clearly got worse does. Check held-out cases separately: a winner that fails them may be tuned to the cases it saw.

## Step 5: Deliver the proposal

Give the user the proposal:

```json
{
  "variantId": "search-trigger-phrases",
  "metric": "toolRecall",
  "baselineValue": 0.62,
  "candidateValue": 0.91,
  "delta": 0.29,
  "toolChanges": {
    "search": { "description": "Search internal company knowledge: …" }
  },
  "improvedCaseIds": ["find-planning-doc-indirect", "pto-answer"],
  "regressedCaseIds": [],
  "recommendation": "apply"
}
```

With it, a short summary: what changed, the hypothesis it tested and why it worked, the change with its trial count ("recall 0.62 → 0.91 over 10 trials per case"), held-out results, and the replacement text to paste into the server.

## Checklist

- [ ] The metric follows the failure seen in `toolCallTrace`
- [ ] Regression cases tagged `regression`; some cases tagged `held-out`
- [ ] Each variant has a unique `id` and a `description` stating its hypothesis
- [ ] Variants change descriptive text or names only, never parameter names, types or `required`
- [ ] 10 or more trials per case (`defaultTrials`, or `trials` in the eval config)
- [ ] Dataset and server source untouched
- [ ] The answer includes the proposal, the trial count and the paste-ready text
- [ ] `reject` and `inconclusive` reported plainly
