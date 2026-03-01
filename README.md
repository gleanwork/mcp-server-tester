# @gleanwork/mcp-server-tester

[![Experimental](https://img.shields.io/badge/-Experimental-D8FD49?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMzIgMzIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0yNC4zMDA2IDIuOTU0MjdMMjAuNzY1NiAwLjE5OTk1MUwxNy45MDI4IDMuOTk1MjdDMTMuNTY1MyAxLjkzNDk1IDguMjMwMTkgMy4wODQzOSA1LjE5Mzk0IDcuMDA5ODNDMS42NTg4OCAxMS41NjQyIDIuNDgzIDE4LjExMzggNy4wMzczOCAyMS42NDg5QzguNzcyMzggMjIuOTkzNSAxMC43ODkzIDIzLjcwOTIgMTIuODI3OSAyMy44MTc3QzE2LjE0NjEgMjQuMDEyOCAxOS41MDc3IDIyLjYyNDggMjEuNjc2NSAxOS44MDU1QzI0LjczNDQgMTUuODggMjQuNTE3NSAxMC40MTQ4IDIxLjQ1OTYgNi43Mjc4OUwyNC4zMDA2IDIuOTU0MjdaTTE4LjExOTcgMTcuMDUxMkMxNi4xMDI4IDE5LjYzMiAxMi4zNzI1IDIwLjEwOTEgOS43NzAwMSAxOC4wOTIyQzcuMTg5MTkgMTYuMDc1MiA2LjcxMjA3IDEyLjMyMzMgOC43MjkwMSA5Ljc0MjQ2QzkuNzA0OTQgOC40ODQ1OCAxMS4xMTQ2IDcuNjgyMTQgMTIuNjc2MSA3LjQ4Njk2QzEzLjA0NDggNy40NDM1OCAxMy40MTM1IDcuNDIxOSAxMy43ODIyIDcuNDQzNThDMTQuOTc1IDcuNTA4NjUgMTYuMTI0NCA3Ljk0MjM5IDE3LjA3ODcgOC42Nzk3N0MxOS42NTk1IDEwLjcxODQgMjAuMTM2NiAxNC40NzAzIDE4LjExOTcgMTcuMDUxMloiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0yNC41MTc2IDIxLjY5MjJDMjMuOTMyIDIyLjQ1MTMgMjMuMjgxNCAyMy4xMjM2IDIyLjU2NTcgMjMuNzUyNUMyMS44NzE3IDI0LjMzODEgMjEuMTEyNyAyNC44ODAzIDIwLjMxMDIgMjUuMzM1N0MxOS41Mjk1IDI1Ljc2OTUgMTguNjgzNyAyNi4xMzgyIDE3LjgzNzggMjYuNDIwMUMxNi45OTIgMjYuNzAyIDE2LjEwMjggMjYuODk3MiAxNS4yMTM3IDI3LjAwNTdDMTQuMzI0NSAyNy4xMTQxIDEzLjQzNTMgMjcuMTU3NSAxMi41MjQ0IDI3LjA5MjRDMTEuNjEzNSAyNy4wMjczIDEwLjcyNDMgMjYuODc1NSA5Ljg1Njg0IDI2LjY1ODdMOS42NjE2NSAyNy4zNzQzTDguNzcyNDYgMzAuOTk2MkM5LjkwMDIxIDMxLjI5OTggMTEuMDQ5NyAzMS40NzMzIDEyLjIyMDggMzEuNTZDMTIuMjY0MiAzMS41NiAxMi4zMjkyIDMxLjU2IDEyLjM3MjYgMzEuNTZDMTMuNTAwMyAzMS42MjUxIDE0LjY0OTggMzEuNTgxNyAxNS43NTU4IDMxLjQ1MTZDMTYuOTI3IDMxLjI5OTggMTguMDk4MSAzMS4wMzk1IDE5LjIyNTggMzAuNjcwOEMyMC4zNTM2IDMwLjMwMjIgMjEuNDU5NyAyOS44MjUgMjIuNTAwNyAyOS4yMzk1QzIzLjU2MzQgMjguNjUzOSAyNC41NjEgMjcuOTM4MiAyNS40OTM1IDI3LjE1NzVDMjYuNDQ3OCAyNi4zNTUgMjcuMzE1MyAyNS40NDQyIDI4LjA3NDQgMjQuNDQ2NUMyOC4xODI4IDI0LjMxNjQgMjguMjY5NSAyNC4xNjQ2IDI4LjM3OCAyNC4wMTI4TDI0Ljc3NzkgMjEuMzQ1MkMyNC42Njk0IDIxLjQ1MzcgMjQuNjA0NCAyMS41ODM4IDI0LjUxNzYgMjEuNjkyMloiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPg==&labelColor=343CED)](https://github.com/gleanwork/.github/blob/main/docs/repository-stability.md#experimental)
[![npm version](https://img.shields.io/npm/v/@gleanwork/mcp-server-tester)](https://www.npmjs.com/package/@gleanwork/mcp-server-tester)
[![CI](https://github.com/gleanwork/mcp-server-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/gleanwork/mcp-server-tester/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A testing and evaluation framework for [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers. Write deterministic Playwright tests against your MCP tools, or run data-driven eval datasets — including LLM-based evaluation of tool discoverability.

## Playwright Tests

The `mcp` Playwright fixture connects to your MCP server (stdio or HTTP) and exposes a high-level API for calling tools and asserting responses. Custom matchers keep assertions readable.

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('read_file returns file contents', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: '/tmp/test.txt' });
  expect(result).toContainToolText('Hello, world');
  expect(result).not.toBeToolError();
});

test('server exposes required tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.map((t) => t.name)).toContain('read_file');
});
```

Playwright tests are fast, deterministic, and designed for CI. Use them for regression testing, schema validation, and protocol conformance. The framework includes built-in conformance checks for the MCP spec.

Available matchers:

| Matcher                  | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `toContainToolText`      | Response contains expected substrings           |
| `toMatchToolSchema`      | Response validates against a Zod schema         |
| `toMatchToolPattern`     | Response matches a regex pattern                |
| `toMatchToolSnapshot`    | Response matches a saved baseline               |
| `toBeToolError`          | Response is (or is not) an error                |
| `toHaveToolResponseSize` | Response size is within bounds                  |
| `toSatisfyToolPredicate` | Response satisfies a custom function            |
| `toHaveToolCalls`        | LLM called the expected tools                   |
| `toHaveToolCallCount`    | LLM made N tool calls                           |
| `toPassToolJudge`        | LLM evaluates response quality against a rubric |

## Eval Datasets

Eval datasets let you define test cases as JSON files and run them with `runEvalDataset()`. Each case specifies a tool call and one or more assertions.

```json
{
  "name": "file-ops",
  "cases": [
    {
      "id": "read-config",
      "toolName": "read_file",
      "args": { "path": "/tmp/config.json" },
      "expect": {
        "schema": "file-content",
        "containsText": ["version", "name"]
      }
    },
    {
      "id": "read-readme",
      "toolName": "read_file",
      "args": { "path": "/tmp/README.md" },
      "expect": {
        "snapshot": "readme-snapshot"
      }
    }
  ]
}
```

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

test('file operations eval', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json', {
    schemas: { 'file-content': z.object({ content: z.string() }) },
  });
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

Supported assertion types:

| Type             | Description                                     |
| ---------------- | ----------------------------------------------- |
| `containsText`   | Response includes expected substrings           |
| `schema`         | Response validates against a Zod schema         |
| `regex`          | Response matches a pattern                      |
| `snapshot`       | Response matches a saved baseline               |
| `judge`          | LLM evaluates response quality against a rubric |
| `toolsTriggered` | LLM called the expected tools (LLM host mode)   |

### LLM host mode

In LLM host mode, a real LLM receives your server's tool list and a natural language prompt, then decides which tools to call. This tests whether your tool names, descriptions, and input schemas are clear enough for autonomous use — a different question from whether the tools return correct output.

```json
{
  "id": "find-config",
  "mode": "llm_host",
  "scenario": "Find the application config file and return its contents",
  "llmHostConfig": {
    "provider": "anthropic",
    "model": "claude-opus-4-20250514"
  },
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "read_file", "required": true }]
    }
  }
}
```

LLM host mode makes real API calls and produces non-deterministic results. Use `iterations` to run a case multiple times and measure pass rate rather than expecting 100% on a single run. See the [LLM Host Guide](docs/llm-host.md) for configuration and cost management.

## Installation

Requires Node.js 22+.

```bash
npm install --save-dev @gleanwork/mcp-server-tester @playwright/test zod
```

The Anthropic SDK is only needed for LLM-as-judge assertions or LLM host mode with the Anthropic provider:

```bash
npm install --save-dev @anthropic-ai/sdk
```

## Quick Start

```bash
npx mcp-server-tester init
```

The CLI wizard creates a `playwright.config.ts`, example tests, and a sample eval dataset configured for your server. See the [CLI Guide](./docs/cli.md) for all options.

## Configuration

Point the framework at your MCP server in `playwright.config.ts`:

```typescript
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

For HTTP servers, set `transport: 'http'` and `serverUrl`. For servers that require OAuth, see the [Transports Guide](./docs/transports.md) and [CLI Guide](./docs/cli.md) for authentication setup, including CI/CD token management.

## Documentation

- [Quick Start](./docs/quickstart.md) — detailed setup and configuration
- [Expectations](./docs/expectations.md) — all assertion types including snapshot sanitizers
- [LLM Host Simulation](docs/llm-host.md) — tool discoverability testing
- [API Reference](./docs/api-reference.md)
- [Transports](./docs/transports.md) — stdio and HTTP configuration, OAuth
- [CLI Commands](./docs/cli.md) — init, generate, login, token
- [UI Reporter](./docs/ui-reporter.md) — interactive web UI for test results
- [Development](./docs/development.md) — contributing and building

## Examples

The `examples/` directory contains complete working examples:

- [filesystem-server/](./examples/filesystem-server) — Test suite for Anthropic's Filesystem MCP server: 5 Playwright tests, 11 eval dataset cases, Zod schema validation.
- [sqlite-server/](./examples/sqlite-server) — Test suite for a SQLite MCP server: 11 Playwright tests, 14 eval dataset cases.
- [basic-playwright-usage/](./examples/basic-playwright-usage) — Minimal Playwright patterns.

## Known Limitations

These MCP protocol features are not currently supported. These are deliberate scope decisions, not bugs:

- MCP resources (`listResources`, `readResource`)
- MCP prompts (`listPrompts`, `getPrompt`)
- Server-to-client notifications
- Streaming tool responses (`callTool` waits for the complete response)

If any of these affect your use case, please open an issue.

## License

MIT
