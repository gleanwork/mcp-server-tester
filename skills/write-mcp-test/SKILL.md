---
name: write-mcp-test
description: Generate Playwright tests for MCP server tools. Use when asked to write MCP tests, test MCP tools, or create test files for an MCP server. Produces direct-mode tests using @gleanwork/mcp-server-tester fixtures.
metadata:
  author: gleanwork
  version: '1.0.0'
---

# Write MCP Server Tests

Generate Playwright tests for MCP server tools using `@gleanwork/mcp-server-tester`.

## Before You Start

1. Confirm the project has `@gleanwork/mcp-server-tester` and `@playwright/test` installed
2. Check that `playwright.config.ts` has `mcpConfig` in at least one project's `use` block
3. Identify which MCP tools to test — run `mcp.listTools()` or check the server's tool definitions

## Step 1 — Verify Playwright Config

Every test project needs an `mcpConfig` entry. If it doesn't exist, add one:

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  projects: [
    {
      name: 'my-mcp-server',
      use: {
        mcpConfig: {
          // stdio transport — for servers started as a subprocess
          transport: 'stdio',
          command: 'node',
          args: ['./dist/server.js'],
        },
        // OR http transport — for servers already running
        // mcpConfig: {
        //   transport: 'http',
        //   url: 'http://localhost:3000/mcp',
        // },
      },
    },
  ],
});
```

## Step 2 — Create Test File

Always import `test` and `expect` from the fixtures path:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
```

**Do NOT import from `@gleanwork/mcp-server-tester`** — that path does not include MCP matchers on `expect`.

## Step 3 — Write Tests

### Basic tool test

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test.describe('search tool', () => {
  test('returns results for a valid query', async ({ mcp }) => {
    const result = await mcp.callTool('search', {
      query: 'quarterly planning',
    });

    expect(result).toContainToolText('quarterly');
    expect(result).not.toBeToolError();
  });

  test('handles empty query gracefully', async ({ mcp }) => {
    const result = await mcp.callTool('search', { query: '' });

    // Assert it returns an error or empty result — not a crash
    expect(result).not.toBeToolError();
  });
});
```

### Pattern matching

```typescript
test('returns structured data', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Single regex
  expect(result).toMatchToolPattern(/temperature: \d+/);

  // Multiple patterns — all must match
  expect(result).toMatchToolPattern([/temperature: \d+/, /humidity: \d+%/]);
});
```

### Schema validation with Zod

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

const WeatherSchema = z.object({
  temperature: z.number(),
  conditions: z.string(),
  humidity: z.number().min(0).max(100),
});

test('response matches weather schema', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toMatchToolSchema(WeatherSchema);
});
```

### Error testing

```typescript
test.describe('error handling', () => {
  test('returns error for missing required argument', async ({ mcp }) => {
    const result = await mcp.callTool('search', {});
    expect(result).toBeToolError();
  });

  test('returns specific error message', async ({ mcp }) => {
    const result = await mcp.callTool('get_user', { id: 'nonexistent' });
    expect(result).toBeToolError('not found');
  });

  test('returns one of several error messages', async ({ mcp }) => {
    const result = await mcp.callTool('get_user', { id: 'bad' });
    expect(result).toBeToolError(['not found', 'invalid id']);
  });
});
```

### Snapshot testing

Snapshots compare tool responses against saved baselines. They require Playwright's `testInfo`.

```typescript
test('response matches snapshot', async ({ mcp }, testInfo) => {
  const result = await mcp.callTool('get_config', {});

  // Basic snapshot
  await expect(result).toMatchToolSnapshot('config-response');

  // With sanitizers for non-deterministic values
  await expect(result).toMatchToolSnapshot('config-response', [
    'uuid', // Replace UUIDs
    'timestamp', // Replace Unix timestamps
    'iso-date', // Replace ISO dates
    { remove: ['requestId', 'createdAt'] }, // Remove fields
    { pattern: /token_[a-z0-9]+/, replacement: '[TOKEN]' }, // Custom regex
  ]);
});
```

Update snapshots when tool output intentionally changes:

```bash
npx playwright test --update-snapshots
```

### Response size validation

```typescript
test('response is reasonably sized', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'test' });

  expect(result).toHaveToolResponseSize({ maxBytes: 50000 });
  expect(result).toHaveToolResponseSize({ minBytes: 100, maxBytes: 50000 });
});
```

### LLM judge evaluation

Judge matchers call an LLM to evaluate response quality. They require `await`.

```typescript
test('response is accurate and complete', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Built-in rubric
  await expect(result).toPassToolJudge('correctness');

  // Custom rubric with reference
  await expect(result).toPassToolJudge(
    'Response should contain current temperature in Celsius for the requested city',
    {
      reference: 'London temperature is typically 10-20°C',
      passingThreshold: 0.8,
    }
  );

  // Multiple judges (all must pass)
  await expect(result).toPassToolJudge([
    { rubric: 'correctness' },
    { rubric: 'completeness', threshold: 0.8 },
  ]);
});
```

Built-in rubrics: `'correctness'`, `'completeness'`, `'groundedness'`, `'instruction-following'`, `'conciseness'`

### Custom predicate

For validation logic that doesn't fit the built-in matchers:

```typescript
test('response satisfies custom logic', async ({ mcp }) => {
  const result = await mcp.callTool('list_items', { category: 'books' });

  // Boolean predicate
  await expect(result).toSatisfyToolPredicate(
    (response) => response.data?.items?.length > 0
  );

  // Predicate with custom failure message
  await expect(result).toSatisfyToolPredicate(
    (response, text) => ({
      pass: text.includes('books'),
      message: `Expected response to mention "books" but got: ${text.slice(0, 100)}`,
    }),
    'contains category name'
  );
});
```

### Exact response matching

```typescript
test('returns exact expected response', async ({ mcp }) => {
  const result = await mcp.callTool('ping', {});
  expect(result).toMatchToolResponse({ status: 'ok' });
});
```

## Step 4 — Listing Available Tools

Discover what tools the server exposes:

```typescript
test('server exposes expected tools', async ({ mcp }) => {
  const tools = await mcp.listTools();

  // Check tool names
  const toolNames = tools.map((t) => t.name);
  expect(toolNames).toContain('search');
  expect(toolNames).toContain('get_weather');
});
```

## Step 5 — Auth-Protected Servers

For servers requiring authentication, use the auth fixtures:

```typescript
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';

// Config includes auth
// mcpConfig: {
//   transport: 'http',
//   url: 'http://localhost:3000/mcp',
//   auth: { accessToken: process.env.MCP_ACCESS_TOKEN },
// }
```

## Complete Test File Template

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

test.describe('my-tool', () => {
  test('returns expected content', async ({ mcp }) => {
    const result = await mcp.callTool('my_tool', {
      param1: 'value1',
      param2: 42,
    });

    expect(result).not.toBeToolError();
    expect(result).toContainToolText('expected content');
  });

  test('validates response structure', async ({ mcp }) => {
    const result = await mcp.callTool('my_tool', { param1: 'test' });

    const MySchema = z.object({
      field1: z.string(),
      field2: z.number(),
    });
    expect(result).toMatchToolSchema(MySchema);
  });

  test('handles errors correctly', async ({ mcp }) => {
    const result = await mcp.callTool('my_tool', {});
    expect(result).toBeToolError();
  });

  test('response matches snapshot', async ({ mcp }, testInfo) => {
    const result = await mcp.callTool('my_tool', { param1: 'stable-input' });
    await expect(result).toMatchToolSnapshot('my-tool-baseline', [
      'uuid',
      'timestamp',
    ]);
  });
});
```

## Checklist

Before finishing, verify:

- [ ] Import is from `@gleanwork/mcp-server-tester/fixtures/mcp` (not from root)
- [ ] Async matchers (`toPassToolJudge`, `toMatchToolSnapshot`, `toSatisfyToolPredicate`) use `await`
- [ ] Snapshot tests destructure `testInfo` from the second argument: `async ({ mcp }, testInfo)`
- [ ] Error cases test both the error state and the error message where applicable
- [ ] `playwright.config.ts` has a matching `mcpConfig` entry
- [ ] Tests run with `npx playwright test`
