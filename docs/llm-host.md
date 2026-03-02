# LLM Host Simulation

LLM host simulation tests your MCP server through a real LLM (OpenAI, Anthropic, etc.), exactly as a user would interact with Claude Desktop or ChatGPT. The LLM decides which tools to call based only on their descriptions and schemas — making this the highest-fidelity test of tool discoverability, parameter clarity, and description quality.

## When to Use

Use LLM host simulation when you need to verify:

- **Tool discoverability**: Does the LLM know which tool to call for a given task?
- **Parameter clarity**: Does the LLM fill in parameters correctly without hints?
- **Description quality**: Does the tool description accurately represent what the tool does?
- **End-to-end behavior**: Does the full chain of LLM → tools → response work?

For most regression testing, use direct mode (`callTool`). Reserve LLM host simulation for:

- New tool description development and tuning
- Evaluating tool calling accuracy across scenarios
- Pre-release validation of tool schemas

## Supported Providers

**Native adapters** (built-in, require their SDK):
| Provider | Env Variable | Install |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `npm install @anthropic-ai/sdk` |
| `openai` | `OPENAI_API_KEY` | `npm install openai` |

**Via Vercel AI SDK** (require `ai` + provider SDK):
| Provider | Env Variable | Install |
|---|---|---|
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `npm install ai @ai-sdk/google` |
| `mistral` | `MISTRAL_API_KEY` | `npm install ai @ai-sdk/mistral` |
| `azure` | `AZURE_API_KEY` | `npm install ai @ai-sdk/azure` |
| `deepseek` | `DEEPSEEK_API_KEY` | `npm install ai @ai-sdk/deepseek` |
| `openrouter` | `OPENROUTER_API_KEY` | `npm install ai @openrouter/ai-sdk-provider` |
| `xai` | `XAI_API_KEY` | `npm install ai @ai-sdk/xai` |

## Basic Usage

```typescript
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { runEvalDataset, loadEvalDataset } from '@gleanwork/mcp-server-tester';

test('LLM triggers the right tool', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
```

**Eval dataset with LLM host simulation:**

```json
{
  "name": "tool-discovery-evals",
  "cases": [
    {
      "id": "search-trigger",
      "mode": "llm_host",
      "scenario": "Find recent documents about quarterly planning",
      "llmHostConfig": {
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

```json
{
  "id": "search-accuracy",
  "mode": "llm_host",
  "scenario": "Find documents about MCP testing",
  "llmHostConfig": { "provider": "anthropic" },
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

## LLMHostConfig Options

```typescript
interface LLMHostConfig {
  provider:
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'mistral'
    | 'azure'
    | 'deepseek'
    | 'openrouter'
    | 'xai';
  model?: string; // Model name (provider-specific default if omitted)
  maxToolCalls?: number; // Max tool call steps (default: 10)
  temperature?: number; // LLM temperature (default: 0)
  maxTokens?: number; // Max response tokens
  apiKeyEnvVar?: string; // Override default env var name
}
```

## LLMHostSimulationResult

The response for an `llm_host` case is an `LLMHostSimulationResult`:

```typescript
interface LLMHostSimulationResult {
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
- Ollama (local): Free

**Recommendation:** Use `mode: "direct"` for regression testing. Use `mode: "llm_host"` selectively for tool description quality validation.

## A/B Testing Tool Descriptions

Run two Playwright projects with different `systemPromptAdditions` to compare tool description variants:

```typescript
// playwright.config.ts
projects: [
  {
    name: 'baseline',
    use: {
      mcpConfig: {
        /* ... */
      },
    },
  },
  {
    name: 'with-skill',
    use: {
      mcpConfig: {
        /* ... */
      },
      // If your fixture supports systemPromptAdditions, add them here
    },
  },
];
```

The MCP reporter groups results by project, letting you compare pass rates side-by-side.
