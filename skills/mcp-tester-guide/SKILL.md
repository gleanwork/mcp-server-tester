---
name: mcp-tester-guide
description: Reference guide for @gleanwork/mcp-server-tester — the Playwright-based testing and evaluation framework for MCP servers. Covers import paths, all 11 matchers, transport config, eval datasets, reporter setup, CLI commands, auth patterns, and common anti-patterns. Use when working with MCP server tests or evals.
metadata:
  author: gleanwork
  version: '1.0.0'
---

# MCP Server Tester — Reference Guide

## What This Framework Does

`@gleanwork/mcp-server-tester` is a Playwright-based testing and evaluation framework for Model Context Protocol (MCP) servers. It provides:

- Playwright fixtures for automated MCP tool testing
- Data-driven eval datasets with optional LLM-as-a-judge scoring
- MCP host simulation via real LLM providers (Anthropic, OpenAI, Google, etc.)
- A custom Playwright reporter with an interactive UI

**Requires Node.js >= 22.0.0 and Playwright.**

## Import Paths

The package exposes four entry points:

```typescript
// Main library — types, validators, eval runner, judge, config
import { ... } from '@gleanwork/mcp-server-tester';

// Playwright test fixtures — test() and expect() with MCP matchers
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

// Auth-specific fixtures — for OAuth and token auth testing
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';

// Custom Playwright reporter
import mcpReporter from '@gleanwork/mcp-server-tester/reporters/mcpReporter';
```

Always import `test` and `expect` from `@gleanwork/mcp-server-tester/fixtures/mcp` in test files. The `expect` from the main entry does NOT include MCP matchers.

## Transport Configuration

Configure `mcpConfig` in `playwright.config.ts` under `project.use`:

### stdio transport

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'my-mcp-server',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['./dist/server.js'],
          env: { DEBUG: 'true' },
        },
      },
    },
  ],
});
```

### HTTP (Streamable HTTP / SSE) transport

```typescript
{
  mcpConfig: {
    transport: 'http',
    url: 'http://localhost:3000/mcp',
    headers: { 'Authorization': 'Bearer token' },
  },
}
```

## All 11 Matchers

Use these with `expect(result)` after calling `mcp.callTool()`:

| Matcher                  | Signature                                                       | Purpose                                                                |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `toMatchToolResponse`    | `(expected: unknown)`                                           | Deep-equal match against expected value                                |
| `toContainToolText`      | `(text: string \| string[], options?)`                          | Response contains substring(s). Options: `{ caseSensitive?: boolean }` |
| `toMatchToolPattern`     | `(pattern: string \| RegExp \| (string \| RegExp)[], options?)` | Response matches regex pattern(s)                                      |
| `toMatchToolSchema`      | `(schema: ZodType, options?)`                                   | Validates against a Zod schema                                         |
| `toMatchToolSnapshot`    | `(name: string, sanitizers?)`                                   | Compares against saved snapshot. **Requires Playwright `testInfo`**    |
| `toBeToolError`          | `(expected?: boolean \| string \| string[])`                    | Asserts error state. Use `.not.toBeToolError()` for success            |
| `toPassToolJudge`        | `(rubric: RubricSpec, options?)`                                | LLM evaluates response quality. Async — requires `await`               |
| `toHaveToolResponseSize` | `(options: { minBytes?, maxBytes? })`                           | Response byte size is within bounds                                    |
| `toSatisfyToolPredicate` | `(fn: ToolPredicate, description?)`                             | Custom validation function. Async — requires `await`                   |
| `toHaveToolCalls`        | `(expectation: ToolCallExpectation)`                            | Asserts which tools the LLM called (mcp_host mode only)                |
| `toHaveToolCallCount`    | `(options: { min?, max?, exact? })`                             | Asserts number of tool calls (mcp_host mode only)                      |

### Matcher examples

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

test('weather tool returns valid data', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Text containment
  expect(result).toContainToolText('temperature');
  expect(result).toContainToolText(['temperature', 'conditions']);

  // Regex pattern
  expect(result).toMatchToolPattern(/temperature: \d+/);

  // Schema validation
  const WeatherSchema = z.object({
    temperature: z.number(),
    conditions: z.string(),
  });
  expect(result).toMatchToolSchema(WeatherSchema);

  // Error checking
  expect(result).not.toBeToolError();

  // Size bounds
  expect(result).toHaveToolResponseSize({ maxBytes: 10000 });

  // Snapshot (requires testInfo from Playwright)
  await expect(result).toMatchToolSnapshot('weather-london');

  // LLM judge
  await expect(result).toPassToolJudge('correctness', {
    reference: 'London typically has moderate temperatures',
    passingThreshold: 0.7,
  });

  // Custom predicate
  await expect(result).toSatisfyToolPredicate(
    (response, text) => text.includes('London'),
    'mentions the requested city'
  );
});
```

## Eval Datasets

Data-driven test cases loaded from JSON files.

### Structure

```json
{
  "name": "my-tool-evals",
  "description": "Regression tests for search tool",
  "cases": [
    {
      "id": "basic-search",
      "toolName": "search",
      "args": { "query": "quarterly planning" },
      "expect": {
        "containsText": ["quarterly", "planning"],
        "isError": false,
        "responseSize": { "maxBytes": 50000 }
      }
    }
  ]
}
```

### Loading and running

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('search tool evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/search-evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

### Eval expect block fields

| Field                | Matcher equivalent       | Type                                       |
| -------------------- | ------------------------ | ------------------------------------------ |
| `response`           | `toMatchToolResponse`    | `unknown`                                  |
| `containsText`       | `toContainToolText`      | `string \| string[]`                       |
| `matchesPattern`     | `toMatchToolPattern`     | `string \| string[]`                       |
| `schema`             | `toMatchToolSchema`      | `string` (registry key)                    |
| `snapshot`           | `toMatchToolSnapshot`    | `string`                                   |
| `snapshotSanitizers` | sanitizer param          | `SnapshotSanitizer[]`                      |
| `isError`            | `toBeToolError`          | `boolean \| string \| string[]`            |
| `passesJudge`        | `toPassToolJudge`        | `JudgeExpectConfig \| JudgeExpectConfig[]` |
| `responseSize`       | `toHaveToolResponseSize` | `{ minBytes?, maxBytes? }`                 |
| `toolsTriggered`     | `toHaveToolCalls`        | `{ calls, order?, exclusive? }`            |
| `toolCallCount`      | `toHaveToolCallCount`    | `{ min?, max?, exact? }`                   |

### EvalCase fields

| Field               | Required      | Description                                          |
| ------------------- | ------------- | ---------------------------------------------------- |
| `id`                | Yes           | Unique identifier                                    |
| `description`       | No            | Human-readable description                           |
| `mode`              | No            | `'direct'` (default) or `'mcp_host'`                 |
| `toolName`          | Direct mode   | Tool to call                                         |
| `args`              | Direct mode   | Arguments for the tool                               |
| `scenario`          | mcp_host mode | Natural language prompt for LLM                      |
| `mcpHostConfig`     | No            | Provider, model, host type config                    |
| `expect`            | No            | Expectation block (see above)                        |
| `iterations`        | No            | Number of runs for accuracy measurement (default: 1) |
| `accuracyThreshold` | No            | Min pass rate when iterations > 1 (default: 1.0)     |
| `judgeReps`         | No            | Judge evaluations per assertion (scores averaged)    |
| `canonicalAnswer`   | No            | Golden answer — auto-passed as judge `reference`     |
| `tags`              | No            | String labels for filtering and slicing              |

## Two Testing Modes

### Direct mode (default)

Call a specific tool with known arguments. Fast, deterministic, free.

```json
{
  "id": "search-basic",
  "mode": "direct",
  "toolName": "search",
  "args": { "query": "hello" },
  "expect": { "containsText": "results" }
}
```

### mcp_host mode

An LLM receives a natural language scenario and discovers which tools to call. Non-deterministic, costs money, measures tool description quality.

```json
{
  "id": "search-discovery",
  "mode": "mcp_host",
  "scenario": "Find recent documents about quarterly planning",
  "mcpHostConfig": { "provider": "anthropic" },
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    }
  }
}
```

Use direct mode for regression testing. Use mcp_host mode selectively for tool description quality validation.

## Reporter

Add the MCP reporter to your Playwright config:

```typescript
// playwright.config.ts
export default defineConfig({
  reporter: [
    [
      '@gleanwork/mcp-server-tester/reporters/mcpReporter',
      {
        outputDir: './mcp-report',
        open: 'on-failure',
      },
    ],
  ],
});
```

The reporter generates an interactive HTML report with eval results, conformance checks, and server capabilities.

## CLI Commands

```bash
# Initialize a new test project
npx mcp-server-tester init

# Generate eval dataset from tool schemas
npx mcp-server-tester generate
```

## Auth Patterns

### Static token

```typescript
{
  mcpConfig: {
    transport: 'http',
    url: 'http://localhost:3000/mcp',
    auth: {
      accessToken: process.env.MCP_ACCESS_TOKEN,
    },
  },
}
```

### OAuth 2.1 with PKCE

```typescript
{
  mcpConfig: {
    transport: 'http',
    url: 'http://localhost:3000/mcp',
    auth: {
      oauth: {
        serverUrl: 'https://auth.example.com',
        scopes: ['read', 'write'],
      },
    },
  },
}
```

### Client credentials (CI/CD)

```typescript
{
  mcpConfig: {
    transport: 'http',
    url: 'http://localhost:3000/mcp',
    auth: {
      clientCredentials: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: process.env.MCP_CLIENT_ID,
        clientSecret: process.env.MCP_CLIENT_SECRET,
      },
    },
  },
}
```

## Snapshot Sanitizers

Built-in sanitizers for non-deterministic values:

- `'timestamp'` — Unix timestamps
- `'uuid'` — UUIDs (v4)
- `'iso-date'` — ISO 8601 dates
- `'objectId'` — MongoDB ObjectIds
- `'jwt'` — JSON Web Tokens

Custom sanitizers:

```typescript
// Regex replacement
{ pattern: /api-key-\w+/, replacement: '[API_KEY]' }

// Field removal
{ remove: ['createdAt', 'updatedAt', 'id'] }
```

Update snapshots: `npx playwright test --update-snapshots`

## LLM Judge

### Built-in rubrics

`'correctness'`, `'completeness'`, `'groundedness'`, `'instruction-following'`, `'conciseness'`

### Judge providers

`'anthropic'`, `'vertex-anthropic'`, `'anthropic-agent-sdk'`, `'openai'`, `'google'`

### Custom rubric

```typescript
await expect(result).toPassToolJudge({
  text: 'Response should contain accurate weather data with temperature in Celsius',
});
```

### Custom judge executor

```typescript
import { registerJudge } from '@gleanwork/mcp-server-tester';

registerJudge('my-judge', async (input) => {
  const score = await myCustomEvaluation(input.response);
  return { pass: score > 0.7, score, reason: 'Custom evaluation' };
});

// In test
await expect(result).toPassToolJudge({ judge: 'my-judge' });
```

## MCP Host Providers

For `mcp_host` mode, install `ai` plus the provider package:

| Provider           | Install                                      |
| ------------------ | -------------------------------------------- |
| `anthropic`        | `npm install ai @ai-sdk/anthropic`           |
| `openai`           | `npm install ai @ai-sdk/openai`              |
| `google`           | `npm install ai @ai-sdk/google`              |
| `vertex-anthropic` | `npm install ai @ai-sdk/google-vertex`       |
| `mistral`          | `npm install ai @ai-sdk/mistral`             |
| `azure`            | `npm install ai @ai-sdk/azure`               |
| `deepseek`         | `npm install ai @ai-sdk/deepseek`            |
| `openrouter`       | `npm install ai @openrouter/ai-sdk-provider` |
| `xai`              | `npm install ai @ai-sdk/xai`                 |

Set the corresponding environment variable (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

## Common Anti-Patterns

**Wrong import path for tests:**

```typescript
// WRONG — this expect() does NOT have MCP matchers
import { expect } from '@gleanwork/mcp-server-tester';

// RIGHT — this expect() has all 11 matchers
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
```

**Missing `await` on async matchers:**

```typescript
// WRONG — toPassToolJudge and toMatchToolSnapshot are async
expect(result).toPassToolJudge('correctness');

// RIGHT
await expect(result).toPassToolJudge('correctness');
await expect(result).toMatchToolSnapshot('my-snapshot');
await expect(result).toSatisfyToolPredicate(asyncFn);
```

**Using `toHaveToolCalls` in direct mode:**

```typescript
// WRONG — tool call assertions only work with mcp_host mode
const result = await mcp.callTool('search', { query: 'test' });
expect(result).toHaveToolCalls({ calls: [{ name: 'search' }] });

// RIGHT — use mcp_host mode with a scenario
// Set mode: 'mcp_host' in your eval case
```

**Forgetting `testInfo` for snapshots:**

```typescript
// WRONG — snapshots need Playwright testInfo
test('snapshot', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'test' });
  await expect(result).toMatchToolSnapshot('search-result');
});

// RIGHT — destructure testInfo
test('snapshot', async ({ mcp }, testInfo) => {
  const result = await mcp.callTool('search', { query: 'test' });
  await expect(result).toMatchToolSnapshot('search-result');
});
```

**Missing provider package for mcp_host mode:**

```bash
# WRONG — missing the AI SDK and provider package
# Error: Cannot find module '@ai-sdk/anthropic'

# RIGHT — install both packages
npm install ai @ai-sdk/anthropic
```

**Passing `runEvalDataset` arguments in wrong order:**

```typescript
// WRONG — options and context are separate objects
await runEvalDataset(dataset, mcp, testInfo);

// RIGHT — first arg is options object, second is context object
await runEvalDataset(
  { dataset }, // options — what to run and how
  { mcp, testInfo } // context — Playwright fixtures
);
```
