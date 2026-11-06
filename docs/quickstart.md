# Quick Start Guide

This guide covers detailed setup and configuration for `@gleanwork/mcp-server-tester`.

## Before You Start: Tests and Evals

There are two ways to test an MCP server with this library:

| Kind               | What it tests                                                      | When to use                                                         |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Test**           | You call a tool with specific args and assert on the output        | Regression tests, CI, smoke checks — fast and deterministic         |
| **Eval** (`input`) | A client and its model receive your tools and decide which to call | Testing tool discoverability — requires 10+ trials, costs API money |

Start with tests. Add evals when you need to validate that your tool descriptions work for real users.

## Table of Contents

- [CLI Initialization](#cli-initialization)
- [Manual Setup](#manual-setup)
- [Using MCP Fixtures](#using-mcp-fixtures)
- [Recording Tool Tests](#recording-tool-tests)
- [Creating Eval Datasets](#creating-eval-datasets)
- [Running Evals](#running-evals)

## CLI Initialization

The fastest way to get started is using the CLI:

```bash
npx @gleanwork/mcp-server-tester@beta init

# In a terminal, answer the prompts:
Project name (my-mcp-tests):
MCP transport type:
  1) stdio (local server process)
  2) http (remote server)
Choose 1-2 (1): 1
Server command (node server.js):
Install dependencies now? (Y/n)

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
npm install --save-dev @gleanwork/mcp-server-tester@beta @playwright/test
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

## Recording Tool Tests

The generator calls your server's tools and writes each call as a Playwright test, with assertions suggested from the response. In a terminal, it asks which tools to call:

```bash
npx mst generate --command "node server.js"
```

With `--tool`, it records one call and asks nothing, so a script or an agent can run it:

```bash
npx mst generate --command "node server.js" --tool get_weather --args '{"city":"London"}'
✓ Connected! Found 3 tools
Calling get_weather...
✓ Spec generation complete!
Tests added: 1
```

See the [CLI Guide](./cli.md) for more details on the `generate` command.

## Creating Eval Datasets

An eval case gives the client under test an input, and asserts on what it did. Create a dataset file (e.g., `data/evals.json`):

```json
{
  "name": "weather-tool-evals",
  "cases": [
    {
      "id": "london-weather",
      "input": "What's the weather like in London today?",
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "get_weather",
              "required": true
            }
          ]
        },
        "containsText": "London"
      }
    }
  ]
}
```

Assertions are declared per case in the `assertions` block: which tools the client called (`toolsTriggered`, `toolCallCount`) and its answer (`containsText`, `matchesPattern`). Judges go in the case's `judges` list, beside `assertions`. See the [Evals Guide](./evals-guide.md).

## Running Evals

Use `runEvalDataset` in a test, naming the client and model. In a Playwright test the `api` client runs the model against the test's MCP connection (it calls the model's API, so set its key, such as `ANTHROPIC_API_KEY`):

```typescript snippet=snippets/quickstart-eval-runner.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('run weather evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    { dataset, client: 'api', model: 'claude-haiku-4-5', defaultTrials: 5 },
    { mcp, testInfo }
  );

  expect(result.passed).toBe(result.total);
});
```

See the [Assertions Guide](./assertions.md) for all available assertion types.

## Next Steps

- Explore [Assertion Types](./assertions.md) for validation options
- Learn about [Transport Configuration](./transports.md)
- Set up [Authentication](./authentication.md) for OAuth or token auth
- Check out the [Examples](../examples) for real-world usage
- Read [the run report](./ui-reporter.md) each eval run writes
- Upgrading from a pre-1.0 release? See the [Migration Guide](./migrations/migration-1.0.md)
