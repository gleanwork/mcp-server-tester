# Quick Start Guide

This guide covers detailed setup and configuration for `@gleanwork/mcp-server-tester`.

## Before You Start: Two Testing Modes

There are two ways to test an MCP server with this library — choose before you write your first test:

| Mode                      | What it tests                                               | When to use                                                             |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Direct**                | You call a tool with specific args and assert on the output | Regression tests, CI, smoke checks — fast and deterministic             |
| **MCP host** (`mcp_host`) | A real LLM receives your tools and decides which to call    | Testing tool discoverability — requires 10+ iterations, costs API money |

Start with direct mode. Add LLM host mode when you need to validate that your tool descriptions work for real users.

## Table of Contents

- [CLI Initialization](#cli-initialization)
- [Manual Setup](#manual-setup)
- [Using MCP Fixtures](#using-mcp-fixtures)
- [Creating Eval Datasets](#creating-eval-datasets)
- [Running Evals](#running-evals)

## CLI Initialization

The fastest way to get started is using the CLI:

```bash
npx mcp-server-tester init

# Follow the interactive prompts:
? Project name: my-mcp-tests
? MCP transport type: stdio (local server process)
? Server command (for stdio): node server.js
? Install dependencies now? Yes

✓ Project initialized successfully!

Next steps:
  cd my-mcp-tests
  npm test
```

This creates:

- `playwright.config.ts` - Configured for your MCP server
- `tests/mcp.spec.ts` - Example tests
- `data/example-dataset.json` - Sample eval dataset
- `package.json` - With all dependencies

See the [CLI Guide](./cli.md) for all options.

## Manual Setup

If you prefer to set up your project manually:

### 1. Install Dependencies

```bash
npm install --save-dev @gleanwork/mcp-server-tester @playwright/test
```

### 2. Configure Playwright

Add MCP configuration to your `playwright.config.ts`:

```typescript snippet=snippets/playwright-config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['@gleanwork/mcp-server-tester/reporters/mcpReporter']],
  projects: [
    {
      name: 'my-server',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    },
  ],
});
```

See the [Transports Guide](./transports.md) for HTTP and other transport configurations.

## Using MCP Fixtures

Import the test fixtures and use the `mcp` fixture in your tests:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('lists tools from MCP server', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});

test('calls a tool', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toBeTruthy();
});
```

Available fixtures:

- `mcpClient: Client` - Raw MCP SDK client
- `mcp: MCPFixtureApi` - High-level test API with helper methods

See the [API Reference](./api-reference.md) for complete fixture documentation.

## Creating Eval Datasets

### Using the Interactive Generator (Recommended)

The easiest way to create datasets is using the interactive generator:

```bash
npx mcp-server-tester generate

# Interactive workflow:
? MCP transport type: stdio
? Server command: node server.js
✓ Connected to MCP server
✓ Found 3 tools

? Select tool to test: get_weather
? Tool arguments (JSON): { "city": "London" }
✓ Tool called successfully

Response preview:
{
  "city": "London",
  "temperature": 20,
  "conditions": "Sunny"
}

Suggested expectations:
  Text contains:
    - "London"
    - "temperature"
  Regex patterns:
    - \d+

? Test case ID: weather-london
? Add text contains expectations? Yes
? Add regex expectations? Yes
✓ Added test case "weather-london"

? Add another test case? No
✓ Dataset saved to data/dataset.json
```

See the [CLI Guide](./cli.md) for more details on the `generate` command.

### Manual Dataset Creation

Create a dataset file manually (e.g., `data/evals.json`):

```json
{
  "name": "weather-tool-evals",
  "cases": [
    {
      "id": "london-weather",
      "toolName": "get_weather",
      "args": { "city": "London" },
      "expect": {
        "schema": "weather-response",
        "containsText": ["London", "temperature"]
      }
    }
  ]
}
```

Expectations are declared per-case in the `expect` block. The `schema` field names a Zod schema registered when loading the dataset. See the [Expectations Guide](./expectations.md) for all available fields.

## Running Evals

Use the `runEvalDataset` function in your tests:

```typescript snippet=snippets/quickstart-eval-runner.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

test('run weather evals', async ({ mcp }, testInfo) => {
  const WeatherSchema = z.object({
    city: z.string(),
    temperature: z.number(),
    conditions: z.string(),
  });

  const dataset = await loadEvalDataset('./data/evals.json', {
    schemas: { 'weather-response': WeatherSchema },
  });

  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  expect(result.passed).toBe(result.total);
});
```

See the [Expectations Guide](./expectations.md) for all available expectation types.

## Next Steps

- Explore [Expectation Types](./expectations.md) for validation options
- Learn about [Transport Configuration](./transports.md)
- Set up [Authentication](./authentication.md) for OAuth or token auth
- Check out the [Examples](../examples) for real-world usage
- Set up the [UI Reporter](./ui-reporter.md) for interactive test results
- Upgrading from a pre-1.0 release? See the [Migration Guide](./migrations/migration-1.0.md)
