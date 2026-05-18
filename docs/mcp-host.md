# MCP Host Simulation

MCP host simulation tests your MCP server through a real LLM (OpenAI, Anthropic, etc.), exactly as a user would interact with Claude Desktop or ChatGPT. The LLM decides which tools to call based only on their descriptions and schemas — making this the highest-fidelity test of tool discoverability, parameter clarity, and description quality.

## When to Use

Use MCP host simulation when you need to verify:

- **Tool discoverability**: Does the LLM know which tool to call for a given task?
- **Parameter clarity**: Does the LLM fill in parameters correctly without hints?
- **Description quality**: Does the tool description accurately represent what the tool does?
- **End-to-end behavior**: Does the full chain of LLM → tools → response work?

For most regression testing, use direct mode (`callTool`). Reserve MCP host simulation for:

- New tool description development and tuning
- Evaluating tool calling accuracy across scenarios
- Pre-release validation of tool schemas

## Supported Providers

All providers use the Vercel AI SDK. Install `ai` plus the provider-specific package:

| Provider           | Env Variable                   | Install                                      |
| ------------------ | ------------------------------ | -------------------------------------------- |
| `anthropic`        | `ANTHROPIC_API_KEY`            | `npm install ai @ai-sdk/anthropic`           |
| `openai`           | `OPENAI_API_KEY`               | `npm install ai @ai-sdk/openai`              |
| `google`           | `GOOGLE_GENERATIVE_AI_API_KEY` | `npm install ai @ai-sdk/google`              |
| `vertex-anthropic` | `GOOGLE_VERTEX_PROJECT`        | `npm install ai @ai-sdk/google-vertex`       |
| `mistral`          | `MISTRAL_API_KEY`              | `npm install ai @ai-sdk/mistral`             |
| `azure`            | `AZURE_API_KEY`                | `npm install ai @ai-sdk/azure`               |
| `deepseek`         | `DEEPSEEK_API_KEY`             | `npm install ai @ai-sdk/deepseek`            |
| `openrouter`       | `OPENROUTER_API_KEY`           | `npm install ai @openrouter/ai-sdk-provider` |
| `xai`              | `XAI_API_KEY`                  | `npm install ai @ai-sdk/xai`                 |

## Basic Usage

```typescript snippet=snippets/mcp-host-basic-test.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { runEvalDataset, loadEvalDataset } from '@gleanwork/mcp-server-tester';

test('LLM triggers the right tool', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

**Eval dataset with MCP host simulation:**

```json snippet=snippets/mcp-host-tools-triggered.json
{
  "name": "tool-discovery-evals",
  "cases": [
    {
      "id": "search-trigger",
      "mode": "mcp_host",
      "scenario": "Find recent documents about quarterly planning",
      "mcpHostConfig": {
        "provider": "anthropic",
        "model": "claude-3-5-sonnet-20241022"
      },
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        }
      }
    }
  ]
}
```

## Multi-Iteration Accuracy

LLM responses are non-deterministic. Run each case multiple times and measure accuracy:

```json snippet=snippets/mcp-host-iterations.json
{
  "id": "search-accuracy",
  "mode": "mcp_host",
  "scenario": "Find documents about MCP testing",
  "mcpHostConfig": { "provider": "anthropic" },
  "iterations": 5,
  "accuracyThreshold": 0.8,
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    }
  }
}
```

The case passes if `search` was triggered in at least 4 of 5 runs (80% accuracy).

## Tool Call Assertions

### `toolsTriggered` — Assert which tools the LLM called

```json
"toolsTriggered": {
  "calls": [
    { "name": "search", "required": true },
    { "name": "get_document", "required": false }
  ],
  "order": "any",
  "exclusive": false
}
```

- `required: true` — this tool MUST have been called
- `order: "strict"` — calls must appear in the listed order
- `exclusive: true` — no other tools may be called

### `toolCallCount` — Assert number of tool calls

```json
"toolCallCount": { "min": 1, "max": 3 }
```

## MCPHostConfig Options

```typescript
interface MCPHostConfig {
  hostType?: 'sdk' | 'cli' | 'browser' | 'desktop'; // Host type (default: 'sdk')
  provider?: LLMProvider; // Required for 'sdk', ignored for 'cli'
  model?: string; // Model name (provider-specific default if omitted)
  maxToolCalls?: number; // Max tool call steps (default: 10)
  temperature?: number; // LLM temperature (default: 0)
  maxTokens?: number; // Max response tokens
  apiKeyEnvVar?: string; // Override default env var name
  cli?: CLIConfig; // Required for 'cli' host type
}

type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'vertex-anthropic'
  | 'mistral'
  | 'azure'
  | 'deepseek'
  | 'openrouter'
  | 'xai';

interface CLIConfig {
  command: string; // CLI command (e.g., 'claude', 'codex')
  args: string[]; // Arguments — use '{{scenario}}' as prompt placeholder
  outputFormat?: 'text' | 'json' | 'stream-json'; // How to parse stdout (default: 'stream-json')
  timeout?: number; // Command timeout in ms (default: 120000)
}
```

**Host types:**

- **`sdk`** (default) — Programmatic via Vercel AI SDK. Reuses the framework's MCP connection. Requires `provider`.
- **`cli`** — CLI-based hosts (e.g., Claude Code, Codex). Spawns a process with its own MCP connection. Requires `cli`.

## MCPHostSimulationResult

The response for a `mcp_host` case is an `MCPHostSimulationResult`:

```typescript
interface MCPHostSimulationResult {
  success: boolean;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  response?: string; // Final LLM response text
  error?: string; // Error message if success=false
  llmDurationMs?: number; // Time in LLM calls (excludes tool execution)
  mcpDurationMs?: number; // Time in MCP tool execution
  conversationHistory?: Array<{ role: string; content: string }>;
}
```

## Cost Considerations

LLM host simulation calls a real LLM API. Approximate costs:

- Anthropic Claude 3.5 Sonnet: ~$0.003–0.01 per test (varies by tool count)
- OpenAI GPT-4o: ~$0.005–0.02 per test

**Recommendation:** Use `mode: "direct"` for regression testing. Use `mode: "mcp_host"` selectively for tool description quality validation.

## Runtime Tool Override Experiments

Use `toolOverrides` to compare tool metadata variants without changing your eval dataset or MCP server source. The dataset remains the behavioral contract; the override is runtime-only data passed to `runEvalDataset`.

```typescript
const variant = {
  id: 'search-description-v2',
  description: 'Clarify that search is for internal docs and policies.',
  tools: {
    search: {
      description:
        'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language document or policy query.',
          },
        },
        required: ['query'],
      },
    },
  },
};

const baseline = await runEvalDataset(
  { dataset, defaultLlmIterations: 10 },
  { mcp, testInfo }
);

const candidate = await runEvalDataset(
  {
    dataset,
    defaultLlmIterations: 10,
    toolOverrides: variant,
  },
  { mcp, testInfo }
);

const passRateDelta =
  candidate.passed / candidate.total - baseline.passed / baseline.total;
const toolF1Delta =
  (candidate.datasetToolF1 ?? 0) - (baseline.datasetToolF1 ?? 0);
```

`toolOverrides.tools` is keyed by canonical MCP tool name. v1 supports `description` and `inputSchema` replacements only; tool renames, mocked responses, and dataset rewriting are intentionally out of scope.

## Project-Based A/B Testing

Run two Playwright projects with different MCP server configurations when the variant is not limited to runtime metadata. This is useful for comparing different server builds, tool behavior, auth scopes, response shapes, transports, or any change that should be exercised through a real MCP server process.

```typescript
// playwright.config.ts
projects: [
  {
    name: 'baseline',
    use: {
      mcpConfig: {
        transport: 'stdio',
        command: 'node',
        args: ['./dist/server-v1.js'],
      },
    },
  },
  {
    name: 'server-v2',
    use: {
      mcpConfig: {
        transport: 'stdio',
        command: 'node',
        args: ['./dist/server-v2.js'],
      },
    },
  },
];
```

The MCP reporter groups results by project, letting you compare pass rates side-by-side. Prefer `toolOverrides` for description and input schema experiments; use project-based A/B testing when the real server surface or implementation changes.
