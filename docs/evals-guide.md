# Evals Guide

> A practical introduction to building and running evals for MCP servers using `@gleanwork/mcp-server-tester`.

---

## What Is an Eval, and Why Should You Care?

A **test** checks that your code does what you wrote it to do. Pass or fail, deterministic, milliseconds to run.

An **eval** checks that your _system_ does what a _user_ needs it to do. Probabilistic, needs multiple runs, takes seconds or minutes.

For MCP servers, this distinction matters enormously. Your tool definitions — the names, descriptions, and schemas you expose to AI clients — directly affect whether Claude Desktop, ChatGPT, or any other LLM host will actually _use_ your tools correctly. A unit test can verify that your `search` tool returns results. It cannot tell you whether a real user asking "find recent docs about planning" will cause Claude to call `search` in the first place.

That's the gap evals fill.

**The two things evals measure for MCP servers:**

1. **Does the tool work?** — Call it directly with known inputs and check the output. This is deterministic, so it's a Playwright test: run it once.

2. **Will an LLM discover and use the tool correctly?** — Put a real client and model in front of your tools and give it a realistic input. Measure how often it triggers the right tool. This is probabilistic, so it's an eval: run it many times.

---

## The Mental Model: Three Ingredients

Every eval case has three parts:

```text
Input  →  Trial  →  Assertions
```

**Input**: What the case gives the client: the user's request ("Find recent docs about MCP testing").

**Trial**: One attempt at the case: the client and its model receive your tools and the input, and decide which tools to call.

**Assertions**: The pass/fail checks on each trial. Did the response contain expected text? Did the LLM call the right tool? Was the call count in the expected range?

The eval runner runs each case's trials, potentially dozens of them, and reports its pass rate: the share of trials where every assertion passed.

---

## Tests and Evals

### Tool checks are Playwright tests

Call a tool yourself with explicit arguments and assert on its response with MST's matchers:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('search returns results', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'MCP server testing' });
  expect(result).not.toBeToolError();
  expect(result).toHaveToolResponseSize({ minBytes: 100 });
});
```

**When to use it:** Smoke tests. Verifying your tools are connected, responding, and returning the right shape of data. Regression detection when you change tool implementations.

**How many runs:** 1. Tool responses are deterministic (or close enough). Running a search 10 times doesn't tell you more than running it once.

**What you're testing:** The tool itself, not how well it's described. `mcp.request(method, params, schema)` sends any other MCP request, such as `skills/get` or `resources/read`. See the [Assertions Guide](./assertions.md) for every matcher, and `mst generate` to record tests from real calls.

---

### Evals: a Client and Its Model

A real LLM receives your tools and a natural-language input, then decides which tools to call. You assert that it made the right choices.

A case with `input` runs on the client. In a Playwright test, `runEvalDataset` names the client and model (`{ dataset, client: 'mst', model: 'claude-haiku-4-5' }`), and the `mst` client uses the test's MCP connection; a suite eval config names them with `client` and `model`. A case can set its own `client`, `model` and `clientOptions`.

```json snippet=snippets/evals-tools-triggered.json
{
  "name": "llm-host-evals",
  "cases": [
    {
      "id": "llm-triggers-search",
      "input": "Find recent internal documents about the MCP server rollout",
      "passThreshold": 0.8,
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "search",
              "required": true
            }
          ]
        }
      }
    }
  ]
}
```

**When to use it:** Testing whether your tool descriptions actually communicate intent to an LLM. A/B testing tool name or description changes. Validating that tool selectivity works (people questions → `people_search`, not `search`).

**How many trials:** At least 10. LLMs are non-deterministic — the same input may trigger different tools on different runs. 3 trials is almost meaningless statistically. 10 gives you a rough accuracy estimate. 20+ lets you make reliable decisions about whether a change helped.

**What you're testing:** Your tool _descriptions_ and the mental model they create in the LLM, not the tool implementation.

---

## Trials and Pass Rate: The Core Concept

The most important thing to understand about LLM host evals is that a single run tells you almost nothing.

Suppose you run your eval once and the LLM calls the right tool. Did you write a good tool description? Maybe. Did you get lucky? Also maybe. You can't tell from one sample.

**Pass rate** is the fraction of trials where every assertion passed:

```
pass_rate = passing_trials / total_trials
```

If your eval runs 10 times and the LLM picks the right tool 8 times, your pass rate is 0.8 (80%).

**`passThreshold`** is the minimum pass rate needed to consider the eval "passed":

```json
"passThreshold": 0.8
```

This says: "I'll accept this eval as passing if the LLM gets it right at least 80% of the time." Below that threshold, the eval fails — which tells you the tool description needs work.

### Why You Need More Than 3 Trials

Here's the uncomfortable math. With 3 trials, a tool that works 40% of the time is statistically indistinguishable from one that works 94% of the time. The confidence interval is just too wide to make decisions.

| Trials | Margin of error (95% CI) | Useful for                  |
| ------ | ------------------------ | --------------------------- |
| 3      | ±27 percentage points    | Almost nothing              |
| 10     | ±16 percentage points    | Detecting large regressions |
| 20     | ±10 percentage points    | Making real decisions       |
| 50     | ±6 percentage points     | Release gates               |

**Practical recommendation:** 10 trials for development/CI, 20 for release gates. The `defaultTrials` option in `runEvalDataset` sets this globally so you don't have to repeat it on every case:

```typescript
await runEvalDataset({ dataset, defaultTrials: 10 }, { mcp, testInfo });
```

Individual cases can override this with their own `trials` field.

---

## Designing Good Inputs

This is where most eval efforts fall short. A single input phrasing tests whether your tool works for that exact phrasing, not whether the description is generally good.

### The Diversity Problem

If your only input for `people_search` is "Who leads the developer platform team?", and the LLM gets it right 10/10 times, you've learned that _that exact phrasing_ works. You haven't learned whether it works for "find the VP of engineering" or "who should I talk to about API access?" Those might fail.

**Rule of thumb:** Write at least 2-3 input phrasings per tool. Vary the vocabulary, the level of directness, and the implied user goal.

```json
{ "input": "Who leads the developer platform team?" },
{ "input": "Find engineers who work on the MCP server" },
{ "input": "Who should I contact about developer API integrations?" }
```

### Input Design Checklist

1. **Use natural phrasing** — Write inputs the way a real user would ask the question, not the way an engineer would phrase a function call. "Search for recent documents about the Q4 planning process" not "Call search with query 'Q4 planning'."

2. **Test the _intent_, not the keyword** — Good tool descriptions work even when the user doesn't use the tool's name. "Find recent documents" should trigger `search` without the user saying "search".

3. **Test selectivity** — For each tool, write an input that should trigger it and NOT other tools. This catches over-triggering (using `search` when `people_search` would be better).

4. **Include ambiguous cases** — Real users write ambiguous queries. "Tell me about the planning process" could be a search OR a chat question. Decide what the right behavior is and assert it.

5. **Match the user population** — Your tool descriptions need to work for the range of users who will actually use the system, not just for you. If your users are non-technical, test non-technical phrasings.

### Negative Cases

Not every input should expect a tool call. Some inputs should result in the LLM answering from context without calling any tools:

```json
{
  "id": "llm-no-tool-needed",
  "input": "What's 2 + 2?",
  "assertions": {
    "toolCallCount": { "exact": 0 }
  }
}
```

This tests that your tools don't _over-trigger_ for questions that don't need them.

---

## The Assertion Types

### `containsText`

Does the client's answer include expected substrings?

```json
{ "containsText": ["temperature", "London"] }
```

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
      "input": "Find recent internal documents about the Q4 planning process",
      "passThreshold": 0.7,
      "assertions": {
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
      "input": "Find recent internal documents about the Q4 planning process",
      "passThreshold": 0.7,
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "search",
              "required": true
            }
          ]
        },
        "toolCallCount": {
          "min": 1,
          "max": 5
        },
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

## How to Think About Pass Thresholds

`passThreshold` is not a number to pick arbitrarily. It's a decision about acceptable failure rates.

**Think of it as:** "In what fraction of real user interactions am I OK with the wrong tool being called?"

| Threshold | What it means                     | When to use                    |
| --------- | --------------------------------- | ------------------------------ |
| 1.0       | Zero tolerance — must always work | Critical paths, primary tools  |
| 0.9       | 1 in 10 interactions may fail     | Important secondary tools      |
| 0.8       | 1 in 5 interactions may fail      | Useful but not essential tools |
| 0.7       | 3 in 10 interactions may fail     | Experimental features          |

A threshold of 0.8 with 10 trials means: "This eval passes if 8 or more of 10 runs trigger the right tool."

If your description is genuinely good, you should comfortably exceed this threshold. If you're regularly sitting at exactly 8/10, your description may be borderline and worth revisiting.

---

## Interpreting Results

When your eval runs, the reporter shows:

```
PASS  llm-search-phrasing-a  (pass rate: 90%)  — 9/10 trials passed
PASS  llm-people-search     (pass rate: 100%) — 10/10 trials passed
FAIL  llm-meeting-lookup       (pass rate: 60%)  — 6/10 trials passed  ← needs work
```

**100% pass rate:** Your tool description is crystal clear for this input phrasing. The LLM always knows exactly what to do.

**80–90% pass rate:** The description works well. Small wording improvements might push it higher, but it's production-ready.

**60–79% pass rate:** The description is ambiguous or competing with other tool descriptions. Worth investigating — look at which trials failed and what tools the LLM called instead.

**Below 60%:** The LLM is guessing. Something is fundamentally unclear about the tool's purpose, or a competing tool is attracting these queries.

**How to debug a low pass rate:** Look at the trial-level breakdown in the detail view. If the LLM consistently picks `search` when you wanted `people_search`, the distinction between the two tools isn't clear enough in their descriptions.

---

## A/B Testing Tool Descriptions

The killer use case for client evals is testing whether a description change actually helps. Run the same dataset with the server's descriptions and with a variant (`toolOverrides`), which MST shows the model in place of the server's own, without changing the server:

```typescript
const run = {
  dataset,
  client: 'mst',
  model: 'claude-haiku-4-5',
  defaultTrials: 10,
};
const baseline = await runEvalDataset(run, { mcp, testInfo });
const candidate = await runEvalDataset(
  {
    ...run,
    toolOverrides: {
      id: 'clearer-search',
      tools: {
        search: { description: 'Search company documents by keyword.' },
      },
    },
  },
  { mcp, testInfo }
);
```

Compare the pass rates per case. To decide whether a variant really is better (paired per case, with a significance test and a regression check), use `runVariantExperiment`: see [Runtime Tool Override Experiments](./mcp-host.md#runtime-tool-override-experiments).

---

## Common Mistakes

**Running too few trials.** 3 trials is noise. If you can't afford 10, you're better off with 0 and accepting that you don't have data yet.

**Testing the input, not the description.** If you write the input after looking at the tool description, you're likely to use the same vocabulary the description uses. The LLM will get it right, but a real user might not. Write inputs first.

**Ignoring selectivity.** "Will `search` be called for this input?" is only half the question. "Will `people_search` be called _instead of_ `search` when it should be?" is equally important.

**Setting threshold to 1.0 everywhere.** If your CI requires a 100% pass rate, any LLM non-determinism will cause flaky failures. Reserve 1.0 for cases you're confident are genuinely always correct. Use 0.8–0.9 for most cases.

**Not varying phrasings.** One input per tool gives you one data point. If that input happens to use a keyword from the tool description, you may be measuring nothing.

**Forgetting that the pass rate reflects your description, not the LLM.** When the pass rate is low, the instinct is to blame the model. Usually the issue is the tool description. Try rewriting the description before switching models.

---

## Quick Reference: Eval Dataset Structure

```jsonc
{
  "name": "my-server-evals",
  "description": "Optional description",
  "cases": [
    {
      "id": "unique-case-id",
      "description": "Human-readable description",

      // The client acts on the input
      "input": "Find recent documents about X",
      // Optional: the run (runEvalDataset or a suite) names the client and
      // model; a case can set its own
      "client": "mst",
      "model": "claude-haiku-4-5@20251001", // Vertex, from the @ in the id
      "clientOptions": { "maxToolCalls": 5 },

      // Multiple trials:
      "trials": 10, // or use defaultTrials in the runner
      "passThreshold": 0.8, // fraction that must pass (0–1)

      "assertions": {
        "containsText": ["expected", "text"],
        "matchesPattern": ["\\d+ results"],
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }],
          "order": "any",
          "exclusive": false,
        },
        "toolCallCount": { "min": 1, "max": 5 },
        "passesJudge": {
          "rubric": { "text": "Response must cite specific documents" },
          "threshold": 0.7,
        },
      },
    },
  ],
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

      // The client the cases run on and its model. A case can set its
      // own client, model and clientOptions.
      client: 'mst',
      model: 'claude-haiku-4-5',

      // Run every client case 10 times, unless it sets its own trials
      defaultTrials: 10,

      // Run up to 3 cases at once (careful with rate limits)
      concurrency: 3,
    },
    { mcp, testInfo }
  );

  // result.passed / result.total gives overall pass rate
  // result.caseResults[i].passRate gives the share of trials that passed
  // result.caseResults[i].trialResults gives each trial
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
import { saveBaseline, loadBaseline } from '@gleanwork/mcp-server-tester/evals';

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
`mst open` command opens local reports only in v1.

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

When `saveResultsTo` targets the store, saved results still omit responses by
default. Set `redactStoredResponses: false` when the stored results should
include full responses (`omitResponsesFromBaseline` controls baseline files
written to a path). Every API that stores results (the runner, suites, the
reporter's result store, run and server comparisons, baseline files) removes
each case's raw `response`, and each host trace's
answer text (`finalText`) and tool outputs (event `output`) by default, the
same way. Events, servers, arguments and usage are kept.

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
} from '@gleanwork/mcp-server-tester/evals';

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
    candidate: candidate.metadata?.toolVariantId ?? 'candidate',
  },
});

await saveEvalRunComparison({
  store,
  comparison,
  id: 'candidate-vs-current',
});
```

Stored comparisons omit raw responses unless you pass
`redactStoredResponses: false` to `saveEvalRunComparison()`.

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
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { saveBaseline, loadBaseline } from '@gleanwork/mcp-server-tester/evals';

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

## Comparing servers (A/B testing)

To compare two MCP servers, or two configurations of one, run the same dataset as two variants of a suite, each with its own `servers`:

```json
{
  "name": "server-ab",
  "datasets": ["./evals/triggering.json"],
  "client": "mst",
  "clientOptions": {
    "provider": "anthropic"
  },
  "variants": [
    {
      "name": "production",
      "servers": [
        {
          "transport": "http",
          "serverUrl": "https://mcp.example.com/mcp",
          "label": "prod"
        }
      ]
    },
    {
      "name": "candidate",
      "servers": [
        {
          "transport": "http",
          "serverUrl": "https://staging.example.com/mcp",
          "label": "next"
        }
      ]
    }
  ]
}
```

`mst run --config server-ab.json` runs both variants with the same host and prints a row per variant: cases passed, trial pass rate, MCP calls and host events, tokens, cost and time. The run summary's `variantDeltas` holds each metric's change against the first variant, and with `trials` set, `trial_pass_rate` shows differences that case pass/fail hides. A variant can also differ by host, tool variants (`toolOverrides`), input template or judges. See [Variants](./evaluation-framework.md#variants) and [Metrics](./evaluation-framework.md#metrics).

---

## Where to Go From Here

1. **Start with tool checks** — Write a Playwright test for every tool before adding eval cases. You need to know the tools work before testing whether they're discoverable.

2. **Add 2–3 eval cases per tool** — Focus on the inputs most representative of how real users actually ask questions.

3. **Set `defaultTrials: 10`** — This is the minimum for meaningful pass rates.

4. **Review failing cases first** — A low pass rate on a tool is a signal to rewrite its description, not to lower the threshold.

5. **Run before and after description changes** — Evals earn their keep as a diff tool. The output of a single run is interesting. The delta between two runs is actionable.
