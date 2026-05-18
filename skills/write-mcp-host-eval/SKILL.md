---
name: write-mcp-host-eval
description: Generate LLM host simulation evals for MCP servers. Use when asked to test tool discoverability, write mcp_host evals, or validate tool descriptions with real LLM calls. Produces eval datasets and test runners where an LLM discovers and calls tools from natural language scenarios.
metadata:
  author: gleanwork
  version: '1.0.0'
---

# Write MCP Host Simulation Evals

Generate LLM host simulation evals for MCP servers using `@gleanwork/mcp-server-tester`. In `mcp_host` mode, a real LLM receives a natural language scenario and decides which MCP tools to call — testing tool discoverability, parameter clarity, and description quality.

## When to Use mcp_host Mode

**Use mcp_host mode when you need to verify:**

- Does the LLM know which tool to call for a given task?
- Does the LLM fill in parameters correctly without hints?
- Does the tool description accurately represent what the tool does?

**Use direct mode instead for:**

- Regression testing known inputs/outputs (faster, free, deterministic)
- Testing tool logic and error handling
- Schema validation

mcp_host mode calls a real LLM API. Each test costs ~$0.003–0.02 depending on the provider and tool count.

## Prerequisites

Install the Vercel AI SDK and your provider package:

```bash
# Pick your provider
npm install ai @ai-sdk/anthropic    # Anthropic
npm install ai @ai-sdk/openai       # OpenAI
npm install ai @ai-sdk/google       # Google
npm install ai @ai-sdk/mistral      # Mistral
npm install ai @ai-sdk/azure        # Azure OpenAI
npm install ai @ai-sdk/deepseek     # DeepSeek
npm install ai @ai-sdk/xai          # xAI (Grok)
npm install ai @ai-sdk/google-vertex  # Vertex AI (Anthropic models)
npm install ai @openrouter/ai-sdk-provider  # OpenRouter
```

Set the corresponding API key environment variable (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

## Step 1 — Understand the Case Structure

mcp_host cases differ from direct mode cases:

| Field           | Direct mode          | mcp_host mode                              |
| --------------- | -------------------- | ------------------------------------------ |
| `mode`          | `"direct"` (default) | `"mcp_host"` (required)                    |
| `toolName`      | Required             | Not used                                   |
| `args`          | Required             | Not used                                   |
| `scenario`      | Not used             | Required — natural language prompt         |
| `mcpHostConfig` | Not used             | Provider, model, host type                 |
| `expect`        | Response assertions  | Tool call assertions + response assertions |

The LLM receives the `scenario` as a prompt along with all available MCP tools, then decides which tools to call and with what arguments.

## Step 2 — Write the Eval Dataset

### Basic mcp_host case

```json
{
  "name": "tool-discovery-evals",
  "cases": [
    {
      "id": "search-trigger",
      "mode": "mcp_host",
      "description": "LLM should use the search tool for document queries",
      "scenario": "Find recent documents about quarterly planning",
      "mcpHostConfig": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514"
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

### mcpHostConfig options

```json
"mcpHostConfig": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0,
  "maxToolCalls": 10,
  "maxTokens": 4096
}
```

| Field          | Default          | Description                                                                                                                |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provider`     | —                | Required. One of: `anthropic`, `openai`, `google`, `vertex-anthropic`, `mistral`, `azure`, `deepseek`, `openrouter`, `xai` |
| `model`        | Provider default | Model identifier (e.g., `gpt-4o`, `claude-sonnet-4-20250514`)                                                              |
| `hostType`     | `"sdk"`          | `"sdk"` (programmatic) or `"cli"` (spawns CLI process)                                                                     |
| `temperature`  | `0`              | LLM temperature (0 = most deterministic)                                                                                   |
| `maxToolCalls` | `10`             | Maximum tool call steps                                                                                                    |
| `maxTokens`    | —                | Max response tokens                                                                                                        |
| `apiKeyEnvVar` | —                | Override default env var name                                                                                              |

### CLI host type

For testing with CLI-based hosts like Claude Code:

```json
"mcpHostConfig": {
  "hostType": "cli",
  "cli": {
    "command": "claude",
    "args": ["-p", "{{scenario}}", "--output-format", "stream-json"],
    "outputFormat": "stream-json",
    "timeout": 120000
  }
}
```

The `{{scenario}}` placeholder is replaced with the case's `scenario` value.

## Step 3 — Tool Call Assertions

### `toolsTriggered` — Assert which tools were called

```json
"expect": {
  "toolsTriggered": {
    "calls": [
      { "name": "search", "required": true },
      { "name": "get_document", "required": false }
    ],
    "order": "any",
    "exclusive": false
  }
}
```

| Field               | Default | Description                                         |
| ------------------- | ------- | --------------------------------------------------- |
| `calls[].name`      | —       | Tool name to expect                                 |
| `calls[].required`  | `true`  | Whether this tool MUST have been called             |
| `calls[].arguments` | —       | Expected arguments (partial match)                  |
| `order`             | `"any"` | `"any"` or `"strict"` (must appear in listed order) |
| `exclusive`         | `false` | If `true`, no tools outside the list may be called  |

### Argument matching

Exact match (partial — extra keys in the actual call are allowed):

```json
"calls": [{
  "name": "search",
  "arguments": { "query": "quarterly planning" }
}]
```

Regex match with `$pattern`:

```json
"calls": [{
  "name": "search",
  "arguments": {
    "query": { "$pattern": "quarterly.*planning" }
  }
}]
```

Case-insensitive regex with `$flags`:

```json
"calls": [{
  "name": "search",
  "arguments": {
    "query": { "$pattern": "quarterly", "$flags": "i" }
  }
}]
```

Mix exact and regex matching:

```json
"calls": [{
  "name": "search",
  "arguments": {
    "query": { "$pattern": "planning" },
    "limit": 10
  }
}]
```

### Strict order

```json
"expect": {
  "toolsTriggered": {
    "calls": [
      { "name": "search", "required": true },
      { "name": "get_document", "required": true }
    ],
    "order": "strict"
  }
}
```

The LLM must call `search` before `get_document`.

### Exclusive tool calls

```json
"expect": {
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }],
    "exclusive": true
  }
}
```

The LLM must call ONLY `search` — any other tool call fails the test.

### `toolCallCount` — Assert number of tool calls

```json
"expect": {
  "toolCallCount": { "min": 1, "max": 3 }
}
```

```json
"expect": {
  "toolCallCount": { "exact": 2 }
}
```

### Combining tool call and response assertions

```json
"expect": {
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }]
  },
  "toolCallCount": { "min": 1, "max": 5 },
  "containsText": "results"
}
```

## Step 4 — Multi-Iteration Accuracy

LLM responses are non-deterministic. Run each case multiple times and measure accuracy:

```json
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

- `iterations: 5` — run the case 5 times
- `accuracyThreshold: 0.8` — pass if `search` was triggered in at least 4 of 5 runs (80%)
- Result includes `assertionPassRate` (0–1) and `iterationResults[]`

Use iterations for:

- Measuring tool calling reliability across runs
- Setting realistic accuracy thresholds (start with 0.6, tighten over time)
- Comparing tool description variants (A/B testing)

## Step 5 — Write the Test Runner

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('tool discovery evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/host-evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

**Important:** `runEvalDataset` takes two arguments:

1. **Options object** — `{ dataset, concurrency?, ... }` — what to run and how
2. **Context object** — `{ mcp, testInfo }` — Playwright fixtures from your test

## Step 6 — Runtime Tool Override Experiments

When comparing tool description or input schema variants, do not mutate the eval dataset. Keep the dataset as the behavioral contract and pass variant data dynamically through `runEvalDataset({ toolOverrides })`.

```typescript
const baseline = await runEvalDataset(
  { dataset, defaultLlmIterations: 10 },
  { mcp, testInfo }
);

const variant = {
  id: 'search-description-v2',
  description: 'Clarify that search is for internal docs and policies.',
  tools: {
    search: {
      description:
        'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
    },
  },
};

const candidate = await runEvalDataset(
  {
    dataset,
    defaultLlmIterations: 10,
    toolOverrides: variant,
  },
  { mcp, testInfo }
);
```

For agent-driven remediation loops:

- Generate variants as runtime data, not eval dataset edits.
- Compare baseline and candidate results in userland.
- Report improved cases, regressed cases, pass-rate delta, and tool F1 delta.
- Emit a structured override proposal. Do not edit MCP server source unless the user explicitly asks for source remediation.

## Step 7 — Project-Based A/B Testing

Use project-based A/B testing when the variant is not limited to runtime tool metadata. This is the right path for changed tool behavior, changed auth/config/transport, different server builds, changed response shapes, or any experiment that needs to run against a real MCP server variant.

```typescript
// playwright.config.ts
export default defineConfig({
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
  ],
});
```

The MCP reporter groups results by project, letting users compare pass rates side-by-side.

Choose the comparison mode deliberately:

- Use `toolOverrides` for descriptions and input schemas only.
- Use project-based A/B testing for real server, config, behavior, or response changes.

## Complete Example

### `data/host-evals.json`

```json
{
  "name": "tool-discovery-evals",
  "description": "Validate that LLMs can discover and use tools correctly",
  "cases": [
    {
      "id": "search-basic",
      "mode": "mcp_host",
      "description": "LLM triggers search for document queries",
      "scenario": "Find recent documents about quarterly planning",
      "mcpHostConfig": { "provider": "anthropic" },
      "tags": ["discovery", "search"],
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        }
      }
    },
    {
      "id": "search-with-args",
      "mode": "mcp_host",
      "description": "LLM passes appropriate search arguments",
      "scenario": "Search for onboarding documents for new engineers",
      "mcpHostConfig": { "provider": "anthropic" },
      "tags": ["discovery", "search", "args"],
      "expect": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "search",
              "required": true,
              "arguments": {
                "query": { "$pattern": "onboarding.*engineer", "$flags": "i" }
              }
            }
          ]
        }
      }
    },
    {
      "id": "multi-tool-workflow",
      "mode": "mcp_host",
      "description": "LLM chains search then get_document",
      "scenario": "Find the latest onboarding guide and show me its contents",
      "mcpHostConfig": {
        "provider": "anthropic",
        "maxToolCalls": 5
      },
      "tags": ["workflow", "multi-tool"],
      "expect": {
        "toolsTriggered": {
          "calls": [
            { "name": "search", "required": true },
            { "name": "get_document", "required": true }
          ],
          "order": "strict"
        },
        "toolCallCount": { "min": 2, "max": 5 }
      }
    },
    {
      "id": "search-accuracy",
      "mode": "mcp_host",
      "description": "Search tool is reliably triggered",
      "scenario": "Find documents about MCP testing best practices",
      "mcpHostConfig": { "provider": "anthropic" },
      "iterations": 5,
      "accuracyThreshold": 0.8,
      "tags": ["accuracy", "search"],
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        }
      }
    },
    {
      "id": "no-tool-abuse",
      "mode": "mcp_host",
      "description": "LLM only calls search, not unrelated tools",
      "scenario": "What documents do we have about API design?",
      "mcpHostConfig": { "provider": "anthropic" },
      "tags": ["precision"],
      "expect": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }],
          "exclusive": true
        }
      }
    }
  ]
}
```

### `tests/host-evals.spec.ts`

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test.describe('mcp host simulation evals', () => {
  test('all tool discovery cases pass', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset('./data/host-evals.json');
    const result = await runEvalDataset({ dataset }, { mcp, testInfo });
    expect(result.passed).toBe(result.total);
  });

  test('accuracy cases meet thresholds', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset('./data/host-evals.json');
    const result = await runEvalDataset(
      { dataset, filterTags: ['accuracy'] },
      { mcp, testInfo }
    );
    expect(result.passed).toBe(result.total);
  });
});
```

## Cost Considerations

| Provider                | Approximate cost per test |
| ----------------------- | ------------------------- |
| Anthropic Claude Sonnet | ~$0.003–0.01              |
| OpenAI GPT-4o           | ~$0.005–0.02              |
| Google Gemini           | ~$0.001–0.005             |

Costs scale with tool count (more tools = larger system prompt) and `maxToolCalls`.

**Recommendations:**

- Use `mode: "direct"` for regression testing (free, fast)
- Use `mode: "mcp_host"` selectively for tool description quality validation
- Set `temperature: 0` for most reproducible results
- Start with `iterations: 3` and `accuracyThreshold: 0.6`, tighten as descriptions improve
- Use `exclusive: true` to catch tool confusion early

## Checklist

Before finishing, verify:

- [ ] Every case has `"mode": "mcp_host"`
- [ ] Every case has a `scenario` (natural language prompt, not tool args)
- [ ] `mcpHostConfig.provider` matches an installed `@ai-sdk/<provider>` package
- [ ] The corresponding API key env var is set (e.g., `ANTHROPIC_API_KEY`)
- [ ] `$pattern` regex strings are valid (test with `new RegExp(pattern)`)
- [ ] `iterations` and `accuracyThreshold` are set together (one without the other is a mistake)
- [ ] `exclusive: true` cases have all expected tools in the `calls` array
- [ ] Test runner imports from `@gleanwork/mcp-server-tester/fixtures/mcp`
- [ ] `runEvalDataset` receives two separate arguments: options object and context object
- [ ] Dataset file runs: `npx playwright test tests/my-host-evals.spec.ts`
