---
name: write-mcp-eval
description: Generate data-driven eval datasets for MCP server testing. Use when asked to create evals, evaluation datasets, or data-driven tests for MCP tools. Produces JSON eval datasets and Playwright test runners for @gleanwork/mcp-server-tester.
metadata:
  author: gleanwork
  version: '1.0.0'
---

# Write MCP Eval Datasets

Generate data-driven eval datasets for MCP server tools using `@gleanwork/mcp-server-tester`. Eval datasets are JSON files containing test cases that are loaded and executed by the eval runner.

## When to Use Evals vs Inline Tests

**Use eval datasets when:**

- You have many similar test cases for the same tool (10+ cases)
- Test data changes more frequently than test logic
- Non-engineers need to add or review test cases
- You want to track accuracy over time with baselines

**Use inline Playwright tests (see write-mcp-test skill) when:**

- You need complex setup or teardown logic
- Tests have unique validation requirements
- You're testing tool interactions or multi-step flows

## Step 1 — Create the Eval Dataset JSON

### Minimal dataset

```json
{
  "name": "search-tool-evals",
  "cases": [
    {
      "id": "basic-query",
      "toolName": "search",
      "args": { "query": "quarterly planning" },
      "assertions": {
        "containsText": "quarterly"
      }
    }
  ]
}
```

### Full dataset structure

```json
{
  "name": "search-tool-evals",
  "description": "Regression tests for the search tool",
  "metadata": {
    "version": "1.0",
    "author": "team-name"
  },
  "cases": [
    {
      "id": "basic-query",
      "description": "Simple keyword search returns relevant results",
      "toolName": "search",
      "args": { "query": "quarterly planning" },
      "tags": ["regression", "search"],
      "assertions": {
        "containsText": ["quarterly", "planning"],
        "isError": false,
        "responseSize": { "maxBytes": 50000 }
      }
    }
  ]
}
```

## Step 2 — Write Expectations

Each case's `assertions` block maps directly to a Playwright matcher. Combine multiple expectations — all must pass.

### Text containment (`containsText`)

```json
{
  "id": "text-check",
  "toolName": "search",
  "args": { "query": "onboarding" },
  "assertions": {
    "containsText": "onboarding"
  }
}
```

Multiple strings — all must be present:

```json
"assertions": {
  "containsText": ["onboarding", "guide", "new hire"]
}
```

### Regex patterns (`matchesPattern`)

```json
"assertions": {
  "matchesPattern": "temperature: \\d+"
}
```

Multiple patterns — all must match:

```json
"assertions": {
  "matchesPattern": ["temperature: \\d+", "humidity: \\d+%"]
}
```

### Exact response (`response`)

```json
"assertions": {
  "response": { "status": "ok", "count": 42 }
}
```

### Error expectations (`isError`)

```json
// Expect any error
"assertions": { "isError": true }

// Expect no error
"assertions": { "isError": false }

// Expect error containing specific text
"assertions": { "isError": "not found" }

// Expect error containing one of these messages
"assertions": { "isError": ["not found", "does not exist"] }
```

### Response size (`responseSize`)

```json
"assertions": {
  "responseSize": { "maxBytes": 50000 }
}
```

```json
"assertions": {
  "responseSize": { "minBytes": 100, "maxBytes": 50000 }
}
```

### Schema validation (`schema`)

Schemas are referenced by name and registered in the test runner:

```json
"assertions": {
  "schema": "WeatherResponse"
}
```

Register schemas when loading the dataset (see Step 3).

### Snapshot comparison (`snapshot`)

```json
"assertions": {
  "snapshot": "search-basic-result",
  "snapshotSanitizers": [
    "uuid",
    "timestamp",
    { "remove": ["requestId"] },
    { "pattern": "token_[a-z0-9]+", "replacement": "[TOKEN]" }
  ]
}
```

Built-in sanitizers: `"uuid"`, `"timestamp"`, `"iso-date"`, `"objectId"`, `"jwt"`

### LLM judge (`passesJudge`)

Single judge:

```json
"assertions": {
  "passesJudge": {
    "rubric": "correctness",
    "threshold": 0.8
  }
}
```

With reference answer:

```json
{
  "id": "weather-accuracy",
  "toolName": "get_weather",
  "args": { "city": "London" },
  "expected": {
    "answer": "London typically has temperatures between 10-20°C with partly cloudy conditions"
  },
  "assertions": {
    "passesJudge": {
      "rubric": "correctness",
      "threshold": 0.7
    }
  }
}
```

The `expected.answer` field is automatically passed as `reference` to the judge.

Custom rubric text:

```json
"assertions": {
  "passesJudge": {
    "rubric": { "text": "Response should contain accurate temperature data in Celsius" },
    "threshold": 0.7
  }
}
```

Multiple judges (all must pass):

```json
"assertions": {
  "passesJudge": [
    { "rubric": "correctness", "threshold": 0.8 },
    { "rubric": "completeness", "threshold": 0.7 },
    {
      "rubric": { "text": "Response mentions the requested city by name" },
      "threshold": 0.9
    }
  ]
}
```

Plugin judge (a judge your plugin provides, as `namespace/name`):

```json
"assertions": {
  "passesJudge": {
    "judge": "my/quality",
    "threshold": 0.7
  }
}
```

Built-in rubrics: `"correctness"`, `"completeness"`, `"groundedness"`, `"instruction-following"`, `"conciseness"`

Judge providers: `"anthropic"`, `"vertex-anthropic"`, `"anthropic-agent-sdk"`, `"openai"`, `"google"`

### Combining expectations

All expectations in a single `assertions` block must pass:

```json
"assertions": {
  "containsText": ["temperature", "humidity"],
  "matchesPattern": "\\d+°[CF]",
  "isError": false,
  "responseSize": { "maxBytes": 10000 },
  "passesJudge": { "rubric": "correctness" }
}
```

## Step 3 — Write the Test Runner

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('search tool evals pass', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/search-evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

**Important:** `runEvalDataset` takes two arguments:

1. **Options object** — `{ dataset, concurrency?, filterTags?, ... }` — what to run and how
2. **Context object** — `{ mcp, testInfo }` — Playwright fixtures from your test

### With schema registry

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const schemas = {
  WeatherResponse: z.object({
    temperature: z.number(),
    conditions: z.string(),
  }),
  SearchResult: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        snippet: z.string(),
      })
    ),
  }),
};

test('evals with schema validation', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json', { schemas });
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

### With concurrency

```typescript
test('evals run in parallel', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset(
    { dataset, concurrency: 4 },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
```

### With tag filtering

```typescript
test('only run regression evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset(
    { dataset, filterTags: ['regression'] },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
```

### Loading from an object (no file)

```typescript
import { loadEvalDatasetFromObject } from '@gleanwork/mcp-server-tester';

test('inline dataset', async ({ mcp }, testInfo) => {
  const dataset = loadEvalDatasetFromObject({
    name: 'inline-evals',
    cases: [
      {
        id: 'test-1',
        toolName: 'search',
        args: { query: 'test' },
        assertions: { containsText: 'result' },
      },
    ],
  });
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

## Step 4 — Baseline Comparison

Save eval results as a baseline and compare future runs:

```typescript
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { saveBaseline, loadBaseline } from '@gleanwork/mcp-server-tester/evals';

test('search evals match baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  // First run: save baseline
  // await saveBaseline(result, { path: './data/baseline.json' });

  // Subsequent runs: compare against baseline
  const baseline = await loadBaseline('./data/baseline.json');
  expect(result.passed).toBeGreaterThanOrEqual(baseline.passed);
});
```

## Step 5 — Trials and Pass Rate

Run each case multiple times and measure the pass rate:

```json
{
  "id": "search-reliability",
  "toolName": "search",
  "args": { "query": "quarterly planning" },
  "trials": 5,
  "passThreshold": 0.8,
  "assertions": {
    "containsText": "quarterly"
  }
}
```

- `trials`: Number of times to run the case (default: 1)
- `passThreshold`: Minimum fraction of trials that must pass (default: 1.0)
- When `trials > 1`, the result includes `assertionPassRate` (0–1) and `iterationResults[]`

## Complete Example

### `data/search-evals.json`

```json
{
  "name": "search-tool-evals",
  "description": "Comprehensive eval suite for the search tool",
  "cases": [
    {
      "id": "basic-query",
      "description": "Simple keyword search",
      "toolName": "search",
      "args": { "query": "quarterly planning" },
      "tags": ["regression", "basic"],
      "assertions": {
        "containsText": ["quarterly", "planning"],
        "isError": false
      }
    },
    {
      "id": "empty-results",
      "description": "Query with no results returns empty",
      "toolName": "search",
      "args": { "query": "xyzzy_nonexistent_query_12345" },
      "tags": ["edge-case"],
      "assertions": {
        "isError": false,
        "responseSize": { "maxBytes": 1000 }
      }
    },
    {
      "id": "special-characters",
      "description": "Query with special characters is handled",
      "toolName": "search",
      "args": { "query": "hello & goodbye <world>" },
      "tags": ["edge-case"],
      "assertions": {
        "isError": false
      }
    },
    {
      "id": "large-result-set",
      "description": "Large result set is bounded",
      "toolName": "search",
      "args": { "query": "common term" },
      "tags": ["regression", "performance"],
      "assertions": {
        "responseSize": { "maxBytes": 100000 },
        "isError": false
      }
    },
    {
      "id": "quality-check",
      "description": "Results are relevant to query",
      "toolName": "search",
      "args": { "query": "onboarding guide" },
      "expected": {
        "answer": "The onboarding guide covers new hire orientation, including team introductions and system setup"
      },
      "tags": ["quality"],
      "assertions": {
        "containsText": "onboarding",
        "passesJudge": {
          "rubric": "correctness",
          "threshold": 0.7
        }
      }
    }
  ]
}
```

### `tests/search-evals.spec.ts`

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test.describe('search tool evals', () => {
  test('all cases pass', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset('./data/search-evals.json');
    const result = await runEvalDataset({ dataset }, { mcp, testInfo });
    expect(result.passed).toBe(result.total);
  });

  test('regression cases pass', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset('./data/search-evals.json');
    const result = await runEvalDataset(
      { dataset, filterTags: ['regression'] },
      { mcp, testInfo }
    );
    expect(result.passed).toBe(result.total);
  });
});
```

## Checklist

Before finishing, verify:

- [ ] Every case has a unique `id`
- [ ] `toolName` matches an actual tool on the MCP server
- [ ] `args` keys match the tool's input schema
- [ ] JSON is valid — no trailing commas, strings are quoted
- [ ] Test runner imports from `@gleanwork/mcp-server-tester/fixtures/mcp`
- [ ] `runEvalDataset` receives two separate arguments: options object and context object
- [ ] `testInfo` is destructured in the test signature for snapshot expectations
- [ ] Schema names in `"schema": "..."` match keys registered in the `schemas` object
- [ ] Dataset file runs: `npx playwright test tests/my-evals.spec.ts`
