---
name: write-mcp-test
description: Write Playwright tests for MCP servers with @gleanwork/mcp-server-tester (MST). A test calls a server's tools (or sends any MCP request) directly through MST's fixtures and checks the result with its matchers, with no client or model involved. Use when asked to write MCP tests, test MCP tools, check tool responses, errors, schemas or snapshots, run conformance checks, or turn tool checks from a JSON file into tests.
metadata:
  author: gleanwork
  version: '2.0.0'
---

# Write MCP server tests

A test checks a server directly: it calls a tool with fixed arguments through MST's `mcp` fixture and asserts on the response with MST's matchers. Tests are fast and deterministic, so run each once, in CI.

A test has no client and no model, so it can't tell you whether a model would pick the tool. That is an eval: use the `write-mcp-eval` skill.

## Before you start

1. Check that the project has `@gleanwork/mcp-server-tester` and `@playwright/test` (`npm install --save-dev @gleanwork/mcp-server-tester@beta @playwright/test`).
2. Find the tools to test and their input schemas: the server source, or `await mcp.listTools()` in a test.
3. Check `playwright.config.ts` for an `mcpConfig` (Step 1).

`npx mst generate` connects to a server, lets you call tools interactively, and writes the calls as a spec (default `tests/generated.spec.ts`) you can edit. `npx @gleanwork/mcp-server-tester@beta init` scaffolds a new project.

## Step 1: Configure the server

Each Playwright project's `use.mcpConfig` says how to reach the server:

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['@gleanwork/mcp-server-tester/reporters/mcpReporter']],
  projects: [
    {
      name: 'local',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['./dist/server.js'],
          env: { LOG_LEVEL: 'warn' },
        },
      },
    },
    {
      name: 'staging',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://staging.example.com/mcp',
          auth: { accessToken: process.env.MCP_ACCESS_TOKEN },
        },
      },
    },
  ],
});
```

HTTP servers take `serverUrl` (not `url`) and optional `headers`. For auth:

| Need                                 | `auth` setting                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A token you already have             | `{ accessToken: process.env.MCP_ACCESS_TOKEN }`                                                                                    |
| CI, service account, no browser      | `{ clientCredentials: { tokenEndpoint: 'https://auth.example.com/oauth/token' } }` (reads `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`) |
| A user logs in once                  | Run `npx mst login <server-url>`; the `mcp` fixture uses the stored login and refreshes it                                         |
| A browser OAuth flow in global setup | `{ oauth: { serverUrl, scopes, authStatePath } }` (see `docs/authentication.md`)                                                   |

The `mcp` fixture handles auth from `mcpConfig`, so tests don't change. `mst token <server-url> --format gh` prints a stored login as CI secrets.

`mcpConfig.protocol` picks the MCP protocol: `'legacy'` (default), `'auto'`, or a revision such as `'2026-07-28'`. To run every test on both:

```typescript
import { defineConfig } from '@playwright/test';
import { protocolMatrix } from '@gleanwork/mcp-server-tester';

const mcpConfig = {
  transport: 'stdio' as const,
  command: 'node',
  args: ['./dist/server.js'],
};

export default defineConfig({
  projects: protocolMatrix({ name: 'local', use: { mcpConfig } }, [
    'legacy',
    '2026-07-28',
  ]),
});
```

## Step 2: Write tests

Import `test` and `expect` from the fixtures entry point. The `expect` from `@playwright/test` doesn't have MST's matchers.

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test.describe('search', () => {
  test('returns results for a query', async ({ mcp }) => {
    const result = await mcp.callTool('search', {
      query: 'quarterly planning',
    });
    expect(result).not.toBeToolError();
    expect(result).toContainToolText(['quarterly', 'planning']);
  });

  test('server lists the tool', async ({ mcp }) => {
    const tools = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toContain('search');
  });
});
```

The `mcp` fixture:

| Member                                 | Does                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `callTool(name, args)`                 | Calls a tool. Protocol errors (such as `-32602` for an unknown tool) come back as error results, not rejections |
| `listTools()`                          | Every tool the server lists                                                                                     |
| `request(method, params, schema)`      | Sends any MCP request and parses the result with a Zod schema                                                   |
| `listResources()`, `readResource(uri)` | Resources                                                                                                       |
| `skills`                               | Agent Skills over MCP: `supported()`, `list()`, `get(uri)`, `read(uri)`                                         |
| `protocol`                             | The requested and negotiated protocol: `test.skip(mcp.protocol.era !== 'modern')`                               |
| `getServerInfo()`                      | The server's name and version                                                                                   |
| `client`                               | The raw SDK `Client` from `@modelcontextprotocol/client`                                                        |

## Step 3: Choose matchers

| Matcher                                            | Passes when                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `toMatchToolResponse(expected)`                    | The response deep-equals `expected`                                    |
| `toContainToolText(text, { caseSensitive? })`      | The text contains every substring                                      |
| `toMatchToolPattern(patterns)`                     | The text matches every pattern (strings or `RegExp`)                   |
| `toMatchToolSchema(zodSchema)`                     | The structured content or JSON text validates                          |
| `toMatchToolSnapshot(name, sanitizers?)`           | The response matches the saved snapshot. Async                         |
| `toBeToolError(expected?)`                         | The response is an error; a string or list checks the message          |
| `toHaveToolResponseSize({ minBytes?, maxBytes? })` | The text's UTF-8 size is within bounds                                 |
| `toSatisfyToolPredicate(fn, description?)`         | `fn(response, text)` returns `true` or `{ pass: true }`. Async         |
| `toPassToolJudge(rubric, options?)`                | An LLM judge scores the response at or above `passingThreshold`. Async |

`toHaveToolCalls` and `toHaveToolCallCount` check a client's tool calls, not a tool response; they belong to evals.

### Text, patterns and errors

```typescript
test('weather for London', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toContainToolText('London');
  expect(result).toMatchToolPattern([/temperature: -?\d+/, /humidity: \d+%/]);
});

test('unknown city is an error', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'Atlantis' });
  expect(result).toBeToolError(['not found', 'unknown city']);
});

test('missing argument is an error', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', {});
  expect(result).toBeToolError();
});
```

`getToolProtocolError(result)` (from `@gleanwork/mcp-server-tester`) returns `{ code, message }` when the error was a JSON-RPC protocol error, else `null`.

### Schemas

```typescript
import { z } from 'zod';

const Weather = z.object({
  city: z.string(),
  temperature: z.number(),
  conditions: z.string(),
});

test('weather has the documented shape', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toMatchToolSchema(Weather);
});
```

### Snapshots

Snapshots fit deterministic output: help text, config, a mocked backend. Sanitize values that change.

```typescript
test('config output is stable', async ({ mcp }) => {
  const result = await mcp.callTool('get_config', {});
  await expect(result).toMatchToolSnapshot('config', [
    'uuid',
    'iso-date',
    { remove: ['requestId', 'session.id'] },
    { pattern: /token_[a-z0-9]+/, replacement: '[TOKEN]' },
  ]);
});
```

Built-in sanitizers: `uuid`, `iso-date`, `timestamp`, `jwt`, `objectId`. Update snapshots on purpose with `npx playwright test --update-snapshots`, and review the diff.

### Size, predicates and judges

```typescript
test('search output is bounded', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'common term' });
  expect(result).toHaveToolResponseSize({ minBytes: 100, maxBytes: 50_000 });
});

test('search returns at least three results', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'onboarding' });
  await expect(result).toSatisfyToolPredicate((response, text) => {
    const count = text.match(/^## /gm)?.length ?? 0;
    return {
      pass: count >= 3,
      message: `expected 3 or more results, got ${count}`,
    };
  }, 'result count');
});

test('summary is faithful', async ({ mcp }) => {
  const result = await mcp.callTool('summarize', { documentId: 'doc-42' });
  await expect(result).toPassToolJudge('groundedness', {
    passingThreshold: 0.8,
  });
});
```

Judges need an API key (`ANTHROPIC_API_KEY` for the default `anthropic` judge, which also needs `@anthropic-ai/sdk`). Built-in rubrics: `correctness`, `completeness`, `groundedness`, `instruction-following`, `conciseness`; or pass your own text. Options: `passingThreshold` (default 0.7), `reference`, `reps`, `provider`, `model`, and `judge` for a plugin's judge (`{ judge: 'acme/judge/completeness' }`, with `test.use({ mcpPlugins: [plugin] })`). Judges cost a model call and vary between runs, so prefer exact matchers when they can say what you mean.

## Step 4: Other requests and conformance

```typescript
import { z } from 'zod';
import { runConformanceChecks } from '@gleanwork/mcp-server-tester';

test('server conforms to the protocol', async ({ mcp }, testInfo) => {
  const result = await runConformanceChecks(
    mcp,
    { requiredTools: ['search'] },
    testInfo
  );
  expect(result.pass).toBe(true);
});

test('skills are listed', async ({ mcp }) => {
  test.skip(!mcp.skills.supported(), 'server does not serve skills');
  const skills = await mcp.skills.list();
  expect(skills.length).toBeGreaterThan(0);
});

test('custom method', async ({ mcp }) => {
  const result = await mcp.request(
    'acme/status',
    {},
    z.object({ ok: z.boolean() })
  );
  expect(result.ok).toBe(true);
});
```

`runConformanceChecks` runs the checks for the negotiated protocol; failing "should" checks are warnings, and `result.pass` reflects the "must" checks. Pass `testInfo` to show the result in the report.

## Step 5: Tool checks from a JSON file

To keep many tool checks as data, read the file and make each entry a `test()`:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import checks from '../tool-checks.json' with { type: 'json' };

interface ToolCheck {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  containsText?: string[];
  isError?: boolean;
}

for (const check of checks as ToolCheck[]) {
  test(check.name, async ({ mcp }) => {
    const result = await mcp.callTool(check.tool, check.args);
    if (check.isError) expect(result).toBeToolError();
    else expect(result).not.toBeToolError();
    if (check.containsText)
      expect(result).toContainToolText(check.containsText);
  });
}
```

This file is yours, not an MST dataset. MST datasets hold eval cases with an `input`; a 1.x dataset of `toolName` and `args` cases fails to load and becomes tests like these.

## Complete file

```typescript
// tests/weather.spec.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

const Weather = z.object({
  city: z.string(),
  temperature: z.number(),
  conditions: z.string(),
});

test.describe('get_weather', () => {
  test('returns weather for a known city', async ({ mcp }) => {
    const result = await mcp.callTool('get_weather', { city: 'London' });
    expect(result).not.toBeToolError();
    expect(result).toMatchToolSchema(Weather);
    expect(result).toContainToolText('London');
  });

  test('rejects an unknown city', async ({ mcp }) => {
    const result = await mcp.callTool('get_weather', { city: 'Atlantis' });
    expect(result).toBeToolError('not found');
  });

  test('requires a city', async ({ mcp }) => {
    const result = await mcp.callTool('get_weather', {});
    expect(result).toBeToolError();
  });

  test('help text is stable', async ({ mcp }) => {
    const result = await mcp.callTool('get_weather_help', {});
    await expect(result).toMatchToolSnapshot('weather-help');
  });
});
```

Run with `npx playwright test`, and open the report with `npx mst open`.

## Checklist

- [ ] `test` and `expect` come from `@gleanwork/mcp-server-tester/fixtures/mcp`
- [ ] `playwright.config.ts` has an `mcpConfig`; HTTP servers use `serverUrl`; no secrets in the file
- [ ] Tool names and argument keys match the server's input schemas
- [ ] Each tool has a success test and at least one error test (bad or missing arguments)
- [ ] `await` on `toMatchToolSnapshot`, `toSatisfyToolPredicate` and `toPassToolJudge`
- [ ] Snapshots only for deterministic output, with sanitizers for IDs and dates
- [ ] No eval assertions in tests: tool choice by a model belongs in `write-mcp-eval`
- [ ] `npx playwright test` passes
