# Evals Guide

> A practical introduction to building and running evals for MCP servers using `@gleanwork/mcp-server-tester`.

---

## What Is an Eval, and Why Should You Care?

A **test** checks that your code does what you wrote it to do. Pass or fail, deterministic, milliseconds to run.

An **eval** checks that your _system_ does what a _user_ needs it to do. Probabilistic, needs multiple runs, takes seconds or minutes.

For MCP servers, this distinction matters enormously. Your tool definitions — the names, descriptions, and schemas you expose to AI clients — directly affect whether Claude Desktop, ChatGPT, or any other LLM host will actually _use_ your tools correctly. A unit test can verify that your `search` tool returns results. It cannot tell you whether a real user asking "find recent docs about planning" will cause Claude to call `search` in the first place.

That's the gap evals fill.

**The two things evals measure for MCP servers:**

1. **Does the tool work?** — Call it directly with known inputs and check the output. This is deterministic. Run it once.

2. **Will an LLM discover and use the tool correctly?** — Put a real LLM in front of your tools and give it a realistic scenario. Measure how often it triggers the right tool. This is probabilistic. Run it many times.

---

## The Mental Model: Three Ingredients

Every eval case has three parts:

```text
Scenario  →  Run  →  Assertion
```

**Scenario**: The input. In direct mode this is tool arguments (`{ query: "MCP server testing" }`). In LLM host mode this is a natural language prompt ("Find recent docs about MCP testing").

**Run**: Executing the scenario against your MCP server. In direct mode this is a single tool call. In LLM host mode this is an LLM receiving your tools and deciding which ones to call.

**Assertion**: The pass/fail check. Did the response contain expected text? Did the LLM call the right tool? Was the call count in the expected range?

The eval runner orchestrates Scenario → Run → Assertion, potentially dozens of times, and reports back accuracy — the fraction of runs where every assertion passed.

---

## Two Modes

### Direct Mode

You call a tool yourself with explicit arguments. The result is checked against your assertions.

```json
{
  "id": "search-returns-results",
  "mode": "direct",
  "toolName": "search",
  "args": { "query": "MCP server testing" },
  "expect": {
    "isError": false,
    "responseSize": { "minBytes": 100 }
  }
}
```

**When to use it:** Smoke tests. Verifying your tools are connected, responding, and returning the right shape of data. Regression detection when you change tool implementations.

**How many iterations:** 1. Tool responses are deterministic (or close enough). Running a search 10 times doesn't tell you more than running it once.

**What you're testing:** The tool itself, not how well it's described.

---

### LLM Host Mode

A real LLM receives your tools and a natural language scenario, then decides which tools to call. You assert that it made the right choices.

```json snippet=snippets/evals-tools-triggered.json
{
  "name": "llm-host-evals",
  "cases": [
    {
      "id": "llm-triggers-search",
      "mode": "mcp_host",
      "scenario": "Find recent internal documents about the Glean MCP server",
      "mcpHostConfig": {
        "provider": "vertex-anthropic",
        "model": "claude-3-5-haiku@20241022"
      },
      "accuracyThreshold": 0.8,
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        }
      }
    }
  ]
}
```

**When to use it:** Testing whether your tool descriptions actually communicate intent to an LLM. A/B testing tool name or description changes. Validating that tool selectivity works (people questions → `employee_search`, not `search`).

**How many iterations:** At least 10. LLMs are non-deterministic — the same scenario may trigger different tools on different runs. 3 iterations is almost meaningless statistically. 10 gives you a rough accuracy estimate. 20+ lets you make reliable decisions about whether a change helped.

**What you're testing:** Your tool _descriptions_ and the mental model they create in the LLM, not the tool implementation.

---

## Accuracy and Iterations: The Core Concept

The most important thing to understand about LLM host evals is that a single run tells you almost nothing.

Suppose you run your eval once and the LLM calls the right tool. Did you write a good tool description? Maybe. Did you get lucky? Also maybe. You can't tell from one sample.

**Accuracy** is the fraction of runs where every assertion passed:

```
accuracy = passing_iterations / total_iterations
```

If your eval runs 10 times and the LLM picks the right tool 8 times, your accuracy is 0.8 (80%).

**AccuracyThreshold** is the minimum accuracy needed to consider the eval "passed":

```json
"accuracyThreshold": 0.8
```

This says: "I'll accept this eval as passing if the LLM gets it right at least 80% of the time." Below that threshold, the eval fails — which tells you the tool description needs work.

### Why You Need More Than 3 Iterations

Here's the uncomfortable math. With 3 iterations, a tool that works 40% of the time is statistically indistinguishable from one that works 94% of the time. The confidence interval is just too wide to make decisions.

| Iterations | Margin of error (95% CI) | Useful for                  |
| ---------- | ------------------------ | --------------------------- |
| 3          | ±27 percentage points    | Almost nothing              |
| 10         | ±16 percentage points    | Detecting large regressions |
| 20         | ±10 percentage points    | Making real decisions       |
| 50         | ±6 percentage points     | Release gates               |

**Practical recommendation:** 10 iterations for development/CI, 20 for release gates. The `defaultLlmIterations` option in `runEvalDataset` sets this globally so you don't have to repeat it on every case:

```typescript
await runEvalDataset({ dataset, defaultLlmIterations: 10 }, { mcp, testInfo });
```

Individual cases can override this with their own `iterations` field.

---

## Designing Good Scenarios

This is where most eval efforts fall short. A single scenario phrasing tests whether your tool works for that exact phrasing, not whether the description is generally good.

### The Diversity Problem

If your only scenario for `employee_search` is "Who leads the developer platform team?", and the LLM gets it right 10/10 times, you've learned that _that exact phrasing_ works. You haven't learned whether it works for "find the VP of engineering" or "who should I talk to about API access?" Those might fail.

**Rule of thumb:** Write at least 2-3 scenario phrasings per tool. Vary the vocabulary, the level of directness, and the implied user goal.

```json
{ "scenario": "Who leads the developer platform team at Glean?" },
{ "scenario": "Find engineers who work on the MCP server at Glean" },
{ "scenario": "Who should I contact about developer API integrations?" }
```

### Scenario Design Checklist

1. **Use natural phrasing** — Write scenarios the way a real user would ask the question, not the way an engineer would phrase a function call. "Search for recent documents about the Q4 planning process" not "Call search with query 'Q4 planning'."

2. **Test the _intent_, not the keyword** — Good tool descriptions work even when the user doesn't use the tool's name. "Find recent documents" should trigger `search` without the user saying "search".

3. **Test selectivity** — For each tool, write a scenario that should trigger it and NOT other tools. This catches over-triggering (using `search` when `employee_search` would be better).

4. **Include ambiguous cases** — Real users write ambiguous queries. "Tell me about the planning process" could be a search OR a chat question. Decide what the right behavior is and assert it.

5. **Match the user population** — Your tool descriptions need to work for the range of users who will actually use the system, not just for you. If your users are non-technical, test non-technical phrasings.

### Negative Cases

Not every scenario should expect a tool call. Some scenarios should result in the LLM answering from context without calling any tools:

```json
{
  "id": "llm-no-tool-needed",
  "scenario": "What's 2 + 2?",
  "expect": {
    "toolCallCount": { "exact": 0 }
  }
}
```

This tests that your tools don't _over-trigger_ for questions that don't need them.

---

## The Assertion Types

### `isError`

Does the response indicate failure?

```json
{ "isError": false }
```

Use this in direct mode to verify tool calls succeed.

### `containsText`

Does the response text include expected substrings?

```json
{ "containsText": ["Steve", "Calvert"] }
```

### `responseSize`

Is the response within expected size bounds?

```json
{ "responseSize": { "minBytes": 100 } }
```

Useful for smoke tests — a 0-byte response means something went wrong.

### `toolsTriggered`

Did the LLM call the right tools? This is the core assertion for LLM host mode.

```json
{
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }],
    "order": "any",
    "exclusive": false
  }
}
```

- `required: true` — the LLM _must_ call this tool
- `required: false` — it _may_ call this tool, but not required
- `order: "strict"` — calls must appear in the listed order
- `exclusive: true` — only the listed tools may be called (no unexpected tools)

### `toolCallCount`

How many tools did the LLM call?

```json
{ "toolCallCount": { "min": 1, "max": 3 } }
```

Useful for detecting runaway tool use (the LLM calling tools in a loop) or for confirming it found the answer in one shot.

### `passesJudge`

Did an LLM evaluator (judge) say the response was good? This is for quality, not just correctness.

```json snippet=snippets/evals-passes-judge.json
{
  "name": "judge-evals",
  "cases": [
    {
      "id": "search-quality-check",
      "mode": "mcp_host",
      "scenario": "Find recent internal documents about the Q4 planning process",
      "mcpHostConfig": {
        "provider": "vertex-anthropic",
        "model": "claude-3-5-haiku@20241022"
      },
      "accuracyThreshold": 0.7,
      "expect": {
        "passesJudge": {
          "rubric": {
            "text": "The response should cite specific documents, not generic advice"
          },
          "threshold": 0.7
        }
      }
    }
  ]
}
```

This is the most expensive assertion (requires a second LLM call) and the most powerful. Use it when you care not just that the right tool was called, but that the final answer was actually useful.

---

## Stacking Assertions

Assertions compose. A case passes only if _all_ assertions pass. This lets you be precise about what "correct behavior" means:

```json snippet=snippets/evals-combined-assertions.json
{
  "name": "combined-assertion-evals",
  "cases": [
    {
      "id": "search-combined",
      "mode": "mcp_host",
      "scenario": "Find recent internal documents about the Q4 planning process",
      "mcpHostConfig": {
        "provider": "vertex-anthropic",
        "model": "claude-3-5-haiku@20241022"
      },
      "accuracyThreshold": 0.7,
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        },
        "toolCallCount": { "min": 1, "max": 5 },
        "passesJudge": {
          "rubric": "completeness",
          "threshold": 0.7
        }
      }
    }
  ]
}
```

This case only passes if: the LLM called `search`, made between 1 and 5 tool calls total, AND a judge rated the final response as a good synthesis of results.

---

## How to Think About Accuracy Thresholds

`accuracyThreshold` is not a number to pick arbitrarily. It's a decision about acceptable failure rates.

**Think of it as:** "In what fraction of real user interactions am I OK with the wrong tool being called?"

| Threshold | What it means                     | When to use                    |
| --------- | --------------------------------- | ------------------------------ |
| 1.0       | Zero tolerance — must always work | Critical paths, primary tools  |
| 0.9       | 1 in 10 interactions may fail     | Important secondary tools      |
| 0.8       | 1 in 5 interactions may fail      | Useful but not essential tools |
| 0.7       | 3 in 10 interactions may fail     | Experimental features          |

A threshold of 0.8 with 10 iterations means: "This eval passes if 8 or more of 10 runs trigger the right tool."

If your description is genuinely good, you should comfortably exceed this threshold. If you're regularly sitting at exactly 8/10, your description may be borderline and worth revisiting.

---

## Interpreting Results

When your eval runs, the reporter shows:

```
PASS  llm-search-phrasing-a  (accuracy: 90%)  — 9/10 iterations passed
PASS  llm-employee-search     (accuracy: 100%) — 10/10 iterations passed
FAIL  llm-meeting-lookup       (accuracy: 60%)  — 6/10 iterations passed  ← needs work
```

**100% accuracy:** Your tool description is crystal clear for this scenario phrasing. The LLM always knows exactly what to do.

**80–90% accuracy:** The description works well. Small wording improvements might push it higher, but it's production-ready.

**60–79% accuracy:** The description is ambiguous or competing with other tool descriptions. Worth investigating — look at which iterations failed and what tools the LLM called instead.

**Below 60%:** The LLM is guessing. Something is fundamentally unclear about the tool's purpose, or a competing tool is attracting these queries.

**How to debug low accuracy:** Look at the iteration-level breakdown in the detail view. If the LLM consistently picks `search` when you wanted `employee_search`, the distinction between the two tools isn't clear enough in their descriptions.

---

## A/B Testing Tool Descriptions

The killer use case for LLM host evals is testing whether a description change actually helps. The framework supports this through Playwright projects.

Create two projects in `playwright.config.ts`, each pointing at the same MCP server but with different system prompt additions:

```typescript
projects: [
  {
    name: 'baseline',
    use: {
      mcpConfig: { transport: 'http', serverUrl: '...' },
    },
  },
  {
    name: 'with-skill',
    use: {
      mcpConfig: {
        transport: 'http',
        serverUrl: '...',
        // After adding a Glean skill to the LLM host config
      },
      mcpHostConfig: {
        provider: 'anthropic',
      },
    },
  },
];
```

Run both and compare accuracy per tool. The reporter groups results by project, making the comparison straightforward.

---

## Common Mistakes

**Running too few iterations.** 3 iterations is noise. If you can't afford 10, you're better off with 0 and accepting that you don't have data yet.

**Testing the scenario, not the description.** If you write the scenario after looking at the tool description, you're likely to use the same vocabulary the description uses. The LLM will get it right, but a real user might not. Write scenarios first.

**Ignoring selectivity.** "Will `search` be called for this scenario?" is only half the question. "Will `employee_search` be called _instead of_ `search` when it should be?" is equally important.

**Setting threshold to 1.0 everywhere.** If your CI requires 100% accuracy, any LLM non-determinism will cause flaky failures. Reserve 1.0 for cases you're confident are genuinely always correct. Use 0.8–0.9 for most cases.

**Not varying phrasings.** One scenario per tool gives you one data point. If that scenario happens to use a keyword from the tool description, you may be measuring nothing.

**Forgetting that accuracy reflects your description, not the LLM.** When accuracy is low, the instinct is to blame the model. Usually the issue is the tool description. Try rewriting the description before switching models.

---

## Quick Reference: Eval Dataset Structure

```json
{
  "name": "my-server-evals",
  "description": "Optional description",
  "cases": [
    {
      "id": "unique-case-id",
      "description": "Human-readable description",

      "mode": "direct", // or "mcp_host"
      "toolName": "search", // required for direct mode
      "args": { "query": "hello" }, // required for direct mode

      // For mcp_host mode instead:
      "scenario": "Find recent documents about X",
      "mcpHostConfig": {
        "provider": "vertex-anthropic", // or "openai", "anthropic", etc.
        "model": "claude-3-5-haiku@20241022",
        "maxToolCalls": 5
      },

      // Multi-iteration (mainly for mcp_host):
      "iterations": 10, // or use defaultLlmIterations in the runner
      "accuracyThreshold": 0.8, // fraction that must pass (0–1)

      "expect": {
        "isError": false,
        "containsText": ["expected", "text"],
        "responseSize": { "minBytes": 100 },
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }],
          "order": "any",
          "exclusive": false
        },
        "toolCallCount": { "min": 1, "max": 5 },
        "passesJudge": {
          "rubric": { "text": "Response must cite specific documents" },
          "threshold": 0.7
        }
      }
    }
  ]
}
```

---

## Quick Reference: Running Evals

```typescript snippet=snippets/evals-runner-reference.ts
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('my evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/my-evals.json');

  const _result = await runEvalDataset(
    {
      dataset,

      // Apply 10 iterations to all mcp_host cases
      // that don't specify iterations explicitly
      defaultLlmIterations: 10,

      // Run up to 3 cases at once (careful with rate limits)
      concurrency: 3,
    },
    { mcp, testInfo }
  );

  // result.passed / result.total gives overall pass rate
  // result.caseResults[i].accuracy gives per-case accuracy
  // result.caseResults[i].iterationResults gives per-run breakdown
});
```

---

## Baseline Regression Detection

Running an eval once tells you whether your server is passing today. Running it across code changes tells you whether it is still passing. Baseline regression detection automates that comparison: save the results of a known-good run, then compare future runs against it to surface regressions immediately.

### How it works

`runEvalDataset` accepts two options for this workflow:

- `saveResultsTo` — after the run completes, write the full result to a JSON file at the given path. Parent directories are created automatically.
- `baselineResultsFrom` — before the run, load the JSON file at the given path and compare each case result against it by case ID.

When `baselineResultsFrom` is set, the returned `EvalRunnerResult` gains three additional fields:

| Field           | Type     | Meaning                                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------------------ |
| `regressions`   | `number` | Cases that passed in the baseline but failed now                                           |
| `improvements`  | `number` | Cases that failed in the baseline but pass now                                             |
| `deltaPassRate` | `number` | Current pass rate minus baseline pass rate (positive = improvement, negative = regression) |

Each `EvalCaseResult` in `caseResults` also gains a `baselinePass?: boolean` field, so you can see the per-case baseline status in the reporter or inspect it programmatically.

If more than 20% of current case IDs have no matching baseline entry, the runner emits a warning. This usually means the dataset structure changed and the baseline needs to be regenerated.

### The `saveBaseline` and `loadBaseline` functions

These are the low-level functions underlying the `saveResultsTo` / `baselineResultsFrom` options. Export them when you need to manage baselines programmatically — for example, in a CI script that only promotes the baseline after a full suite passes.

```typescript
import { saveBaseline, loadBaseline } from '@gleanwork/mcp-server-tester';

// Write a result to disk.
await saveBaseline(result, '.mcp-test-results/baseline.json');

// Read it back.
const saved = await loadBaseline('.mcp-test-results/baseline.json');
console.log(`Baseline: ${saved.passed}/${saved.total} passing`);
```

`saveBaseline` serializes the entire `EvalRunnerResult` as JSON. `loadBaseline` reads and deserializes it. Both accept any file path; `saveBaseline` creates intermediate directories.

### Practical workflow

**Step 1: Capture the baseline on your main branch.**

Run your eval suite after a known-good state and write the results to a file. Commit that file (or store it in CI artifacts) so future runs can reference it.

```typescript
const result = await runEvalDataset(
  {
    dataset,
    saveResultsTo: '.mcp-test-results/baseline.json',
  },
  { mcp, testInfo }
);
```

**Step 2: Re-run after changes and compare.**

On the next run — after modifying tool implementations, descriptions, or server logic — load the baseline and check for regressions:

```typescript
const result = await runEvalDataset(
  {
    dataset,
    baselineResultsFrom: '.mcp-test-results/baseline.json',
  },
  { mcp, testInfo }
);

// Fail the test if any previously passing case now fails.
expect(result.regressions).toBe(0);
```

**Step 3: Refresh the baseline when you intentionally change behavior.**

After a deliberate improvement that changes pass/fail outcomes, run with `saveResultsTo` again to update the file. Treat this the same way you would treat a snapshot update — review the diff, confirm it reflects intended changes, and commit.

The combination of `saveResultsTo` and `baselineResultsFrom` can be used in the same run to simultaneously update the baseline and compare against the previous one. Pass both options if you want a rolling comparison.

## External Result Storage

Eval results can be stored outside the local workspace so CI runs, local runs, and
AI analysis tools can share the same run history. The first built-in cloud store is
GCS. Local file paths continue to work unchanged.

### Authentication

GCS storage uses Application Default Credentials. Do not put credential JSON in
Playwright config.

For local development, create a service-account key with read/write access to the
bucket prefix and load it with `.env`:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

For CI, store the service-account JSON as a secret, write it to a temporary file,
and set `GOOGLE_APPLICATION_CREDENTIALS` for the test step.

### Reporter History

Configure the MCP reporter with a GCS result store to keep dashboard history across
machines and CI jobs:

```typescript snippet=snippets/result-store-reporter-config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    [
      '@gleanwork/mcp-server-tester/reporters/mcpReporter',
      {
        outputDir: '.mcp-test-results',
        resultStore: {
          provider: 'gcs',
          bucket: 'my-mcp-eval-results',
          prefix: 'my-server/main',
        },
        runMetadata: {
          branch: process.env.GITHUB_REF_NAME ?? 'local',
          trigger: process.env.GITHUB_EVENT_NAME ?? 'manual',
        },
      },
    ],
  ],
});
```

The reporter still writes `.mcp-test-results/latest/` locally. The
`mcp-server-tester open` command opens local reports only in v1.

### Stored Baselines

Use a stored `latest` baseline when you want CI to compare against the most recently
promoted known-good run:

```typescript snippet=snippets/result-store-baseline.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

const resultStore = {
  provider: 'gcs' as const,
  bucket: 'my-mcp-eval-results',
  prefix: 'my-server/baselines',
};

test('save latest baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      resultStore,
      saveResultsTo: { store: true, ref: 'latest' },
    },
    { mcp, testInfo }
  );

  expect(result.failed).toBe(0);
});

test('compare against latest baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      resultStore,
      baselineResultsFrom: { store: true, ref: 'latest' },
    },
    { mcp, testInfo }
  );

  expect(result.regressions ?? 0).toBe(0);
});
```

When `saveResultsTo` targets the store, baseline saves still omit responses by
default. Set `omitResponsesFromBaseline: false` when the stored baseline should
include full responses.

### Stored Variant Comparisons

Stored eval runs can be loaded back into `compareEvalRuns()`. This is useful for
tool override experiments where one run captures the current tool metadata and
another captures a proposed variant.

```typescript snippet=snippets/result-store-compare-runs.ts
import {
  compareEvalRuns,
  createEvalResultStore,
  loadStoredEvalRunnerResult,
  saveEvalRunComparison,
} from '@gleanwork/mcp-server-tester';

const store = createEvalResultStore({
  provider: 'gcs',
  bucket: 'my-mcp-eval-results',
  prefix: 'my-server/variants',
});

const baseline = await loadStoredEvalRunnerResult(store, { id: 'baseline' });
const candidate = await loadStoredEvalRunnerResult(store, { id: 'candidate' });

const comparison = compareEvalRuns({
  baseline: baseline.data,
  candidate: candidate.data,
  labels: {
    baseline: 'current',
    candidate: candidate.metadata?.toolOverrideVariantId ?? 'candidate',
  },
});

await saveEvalRunComparison({
  store,
  comparison,
  id: 'candidate-vs-current',
});
```

### Stored Server Comparisons

`runServerComparison()` can persist side-by-side results directly:

```typescript snippet=snippets/result-store-server-comparison.ts
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runServerComparison,
} from '@gleanwork/mcp-server-tester';

test('compare two MCP servers and persist the result', async ({
  mcp,
}, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const otherMcp = mcp;

  await runServerComparison(
    {
      dataset,
      comparisonStore: {
        provider: 'gcs',
        bucket: 'my-mcp-eval-results',
        prefix: 'my-server/server-comparisons',
      },
      comparisonId: `server-comparison-${Date.now()}`,
    },
    { mcp, testInfo },
    { mcp: otherMcp, testInfo }
  );
});
```

### GCS Layout

Given `bucket: "my-mcp-eval-results"` and `prefix: "my-server/main"`, artifacts are
stored as JSON:

```text
gs://my-mcp-eval-results/my-server/main/
├── eval-runs/
│   ├── latest.json
│   └── <run-id>.json
├── reporter-runs/
│   ├── latest.json
│   └── <run-id>.json
└── comparisons/
    ├── eval-runs/
    │   ├── latest.json
    │   └── <comparison-id>.json
    └── servers/
        ├── latest.json
        └── <comparison-id>.json
```

Configure lifecycle retention on the bucket if you do not want to keep every
historical run indefinitely.

### Full example

<!-- snippet=snippets/baseline-comparison.ts -->

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runEvalDataset,
  saveBaseline,
  loadBaseline,
} from '@gleanwork/mcp-server-tester';

// Capture a baseline after a known-good run.
// Run this once on your main branch before making changes.
test('capture baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      saveResultsTo: '.mcp-test-results/baseline.json',
    },
    { mcp, testInfo }
  );

  expect(result.passed).toBe(result.total);
});

// Re-run after code or description changes and compare against the baseline.
test('detect regressions', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      baselineResultsFrom: '.mcp-test-results/baseline.json',
    },
    { mcp, testInfo }
  );

  // Fail the test if any previously passing case now fails.
  expect(result.regressions).toBe(0);

  // Log a summary of the comparison.
  if (result.deltaPassRate !== undefined) {
    const delta = (result.deltaPassRate * 100).toFixed(1);
    const sign = result.deltaPassRate >= 0 ? '+' : '';
    console.log(`Pass rate delta vs baseline: ${sign}${delta}%`);
    console.log(`Regressions: ${result.regressions ?? 0}`);
    console.log(`Improvements: ${result.improvements ?? 0}`);
  }
});

// Use saveBaseline and loadBaseline directly for custom scripting.
test('manual baseline management', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  // Write the result as the new baseline.
  await saveBaseline(result, '.mcp-test-results/baseline.json');

  // Load it back and inspect it.
  const saved = await loadBaseline('.mcp-test-results/baseline.json');
  console.log(`Baseline has ${saved.total} cases, ${saved.passed} passing`);
});
```

---

## Server Comparison (A/B Testing)

`runServerComparison` runs the same eval dataset against two MCP server configurations in parallel and returns a detailed per-case breakdown of which server won, lost, or tied on each case. Use it when you want to compare two versions of a server, two different tool description sets, or any other pair of configurations.

### How it works

`runServerComparison` takes the same options as `runEvalDataset` (minus the baseline-specific fields) and two `EvalContext` objects — one for each server. It runs both servers concurrently with identical cases, then compares results case by case.

For each case, the outcome is one of:

| Outcome     | Meaning                          |
| ----------- | -------------------------------- |
| `A_WINS`    | Server A passed, server B failed |
| `B_WINS`    | Server B passed, server A failed |
| `TIE`       | Both passed                      |
| `BOTH_FAIL` | Both failed                      |

The aggregate `ServerComparisonResult` contains:

| Field              | Type                     | Meaning                                                    |
| ------------------ | ------------------------ | ---------------------------------------------------------- |
| `aWins`            | `number`                 | Cases where server A passed and B failed                   |
| `bWins`            | `number`                 | Cases where server B passed and A failed                   |
| `ties`             | `number`                 | Cases where both passed                                    |
| `bothFail`         | `number`                 | Cases where both failed                                    |
| `decidedCases`     | `number`                 | `aWins + bWins + ties` (excludes `BOTH_FAIL`)              |
| `aWinRate`         | `number`                 | `aWins / decidedCases`                                     |
| `bWinRate`         | `number`                 | `bWins / decidedCases`                                     |
| `tieRate`          | `number`                 | `ties / decidedCases`                                      |
| `failureAlignment` | `number`                 | `bothFail / total` — fraction of cases both servers failed |
| `cases`            | `CaseComparisonResult[]` | Per-case outcomes with full result objects                 |

Win rates exclude `BOTH_FAIL` cases from the denominator. A high `failureAlignment` indicates that the failing cases are a dataset quality problem, not a difference between servers.

### When to use it

- **Comparing server versions before and after a refactor.** Run your eval suite with the old server as A and the new server as B. Cases where B wins are improvements; cases where A wins are regressions.
- **A/B testing tool descriptions.** Point A at a server running with your current descriptions and B at a variant. Win rates quantify which description set performs better on real scenarios.
- **Validating that a new transport or auth layer is equivalent.** Connect A via HTTP and B via stdio (or A with token auth and B with OAuth). A perfect result is all ties.

### Configuration

`runServerComparison` accepts `ServerComparisonOptions`, which is `EvalRunnerOptions` without `saveResultsTo` or `baselineResultsFrom` (baseline fields do not apply to comparisons). All other options — `concurrency`, `defaultLlmIterations`, `filterTags`, etc. — are shared between both server runs.

To construct the second context, create a client with `createMCPClientForConfig` and wrap it with `createMCPFixture`:

```typescript
const clientB = await createMCPClientForConfig({
  transport: 'stdio',
  command: 'node',
  args: ['server-v2.js'],
});
const mcpB = createMCPFixture(clientB);
```

Remember to close the second client in a `finally` block.

### Full example

<!-- snippet=snippets/server-comparison.ts -->

```typescript
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runServerComparison,
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
} from '@gleanwork/mcp-server-tester';

test('compare two server versions', async ({ mcp: mcpA }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  // Build a second MCP context for server B.
  const clientB = await createMCPClientForConfig({
    transport: 'stdio',
    command: 'node',
    args: ['server-v2.js'],
  });
  const mcpB = createMCPFixture(clientB);

  try {
    const comparison = await runServerComparison(
      { dataset },
      { mcp: mcpA, testInfo },
      { mcp: mcpB }
    );

    console.log(`Total cases compared: ${comparison.total}`);
    console.log(
      `Server A win rate: ${(comparison.aWinRate * 100).toFixed(1)}%`
    );
    console.log(
      `Server B win rate: ${(comparison.bWinRate * 100).toFixed(1)}%`
    );
    console.log(`Tie rate: ${(comparison.tieRate * 100).toFixed(1)}%`);
    console.log(
      `Both failed: ${comparison.bothFail} cases (${(comparison.failureAlignment * 100).toFixed(1)}% failure alignment)`
    );

    // Inspect decisive per-case outcomes.
    for (const c of comparison.cases) {
      if (c.outcome !== 'TIE' && c.outcome !== 'BOTH_FAIL') {
        console.log(`  ${c.id}: ${c.outcome}`);
      }
    }
  } finally {
    await closeMCPClient(clientB);
  }
});
```

---

## Where to Go From Here

1. **Start with direct mode** — Build smoke tests for every tool before adding LLM host cases. You need to know the tools work before testing whether they're discoverable.

2. **Add 2–3 LLM host cases per tool** — Focus on the scenarios most representative of how real users actually ask questions.

3. **Set `defaultLlmIterations: 10`** — This is the minimum for meaningful accuracy numbers.

4. **Review failing cases first** — Low accuracy on a tool is a signal to rewrite its description, not to lower the threshold.

5. **Run before and after description changes** — Evals earn their keep as a diff tool. The output of a single run is interesting. The delta between two runs is actionable.
