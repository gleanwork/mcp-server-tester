# Migration: LLM Host Unified to Vercel AI SDK

**Applies to:** Any code that uses `simulateMCPHost()`, imports from the old adapter layer, or extends the LLM host simulation with custom adapters.

---

## What Changed and Why

Previously, LLM host simulation had **two code paths**:

- `openai` and `anthropic` providers used hand-written native adapters (`adapters/openai.ts`, `adapters/anthropic.ts`) that called each SDK directly, managing a manual multi-turn conversation loop via `orchestrator.ts`.
- All other providers (`google`, `azure`, `mistral`, `ollama`, `deepseek`, `openrouter`, `xai`) used the Vercel AI SDK's `generateText`, which handles multi-turn tool calling natively.

This was inconsistent and created unnecessary maintenance burden. The two paths have now been merged: **all 9 providers go through the Vercel AI SDK**.

**Benefits of the unified path:**

- Single agentic loop to maintain and reason about
- `llmDurationMs` and `mcpDurationMs` latency decomposition now works for all providers
- No hand-written conversation state management
- Easier to add new providers (one line in the registry)

---

## Deleted Files

These files no longer exist. Any imports from them will fail at build time:

| Deleted file                               | Replacement                                               |
| ------------------------------------------ | --------------------------------------------------------- |
| `src/evals/mcpHost/adapter.ts`             | No replacement — adapter layer removed                    |
| `src/evals/mcpHost/orchestrator.ts`        | Replaced by `adapters/vercel.ts` (via Vercel AI SDK)      |
| `src/evals/mcpHost/retry.ts`               | No replacement — retry handled by Vercel AI SDK internals |
| `src/evals/mcpHost/adapters/openai.ts`     | Replaced by Vercel `@ai-sdk/openai`                       |
| `src/evals/mcpHost/adapters/anthropic.ts`  | Replaced by Vercel `@ai-sdk/anthropic`                    |
| `src/evals/mcpHost/toolCallExpectation.ts` | Replaced by `expect.toolsTriggered` in eval datasets      |

---

## Removed Public Exports

The following were previously exported from `@gleanwork/mcp-server-tester` (marked `@internal` before removal). They no longer exist:

```typescript
// These no longer exist — remove any imports of them
import {
  registerAdapter, // ❌ removed
  getAdapter, // ❌ removed
  hasAdapter, // ❌ removed
  runSimulation, // ❌ removed
  withRetry, // ❌ removed
  isRetryableError, // ❌ removed
  createToolCallValidator, // ❌ removed
} from '@gleanwork/mcp-server-tester';

import type {
  LLMAdapter, // ❌ removed
  LLMChatResult, // ❌ removed
  ExpectedToolCall, // ❌ removed
  ToolCallValidationResult, // ❌ removed
  ToolCallValidator, // ❌ removed
  RetryOptions, // ❌ removed
} from '@gleanwork/mcp-server-tester';
```

The stable public API remains:

```typescript
// These still work — no change needed
import {
  simulateMCPHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from '@gleanwork/mcp-server-tester';

import type {
  LLMProvider,
  MCPHostConfig,
  MCPHostSimulationResult,
  MCPHostSimulator,
  LLMToolCall,
} from '@gleanwork/mcp-server-tester';
```

---

## Dependency Change for openai and anthropic Users

The `openai` and `anthropic` providers previously used their own native SDKs. They now use the Vercel AI SDK wrappers.

**Before:**

```bash
npm install openai           # for 'openai' provider
npm install @anthropic-ai/sdk # for 'anthropic' provider
```

**After:**

```bash
npm install ai @ai-sdk/openai    # for 'openai' provider
npm install ai @ai-sdk/anthropic # for 'anthropic' provider
```

The `ai`, `@ai-sdk/openai`, and `@ai-sdk/anthropic` packages are already in `optionalDependencies` of `@gleanwork/mcp-server-tester`, so they are installed automatically when you install this package. **No action required** for most users — the packages are already there.

The `openai` and `@anthropic-ai/sdk` packages are no longer used by this library. You can remove them from your own dependencies if you were only installing them for LLM host simulation.

---

## Eval Dataset Config — No Changes Required

The eval dataset JSON format is **unchanged**. Existing datasets continue to work:

```json
{
  "id": "search-trigger",
  "mode": "mcp_host",
  "scenario": "Find recent docs about planning",
  "mcpHostConfig": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }
}
```

`provider: "openai"` and `provider: "anthropic"` still work exactly as before.

---

## Custom Adapter Migration

If you had code that used `registerAdapter()` to register a custom provider:

**Before:**

```typescript
import { registerAdapter } from '@gleanwork/mcp-server-tester';
import type { LLMAdapter } from '@gleanwork/mcp-server-tester';

const myAdapter: LLMAdapter = {
  provider: 'my-provider',
  createClient: async (config) => {
    /* ... */
  },
  formatTools: (tools) => {
    /* ... */
  },
  chat: async (client, messages, tools, config) => {
    /* ... */
  },
  createUserMessage: (scenario) => {
    /* ... */
  },
  createAssistantMessage: (result) => {
    /* ... */
  },
  createToolResultMessage: (toolCall, result) => {
    /* ... */
  },
};

registerAdapter('my-provider', () => myAdapter);
```

**After** — implement `MCPHostSimulator` directly. The interface is simpler because the multi-turn loop is no longer your responsibility:

```typescript
import type { MCPHostSimulator, MCPHostSimulationResult } from '@gleanwork/mcp-server-tester';

const mySimulator: MCPHostSimulator = {
  async simulate(mcp, scenario, config): Promise<MCPHostSimulationResult> {
    // Your implementation here.
    // You are responsible for:
    //   1. Calling your LLM with the scenario and available tools
    //   2. Executing tool calls via mcp.callTool()
    //   3. Continuing until the LLM produces a final response
    //   4. Returning the result in MCPHostSimulationResult shape
    return {
      success: true,
      toolCalls: [...],
      response: '...',
    };
  },
};

// Then use it directly instead of registering:
const result = await mySimulator.simulate(mcp, scenario, config);
```

If you need to make `simulateMCPHost()` dispatch to your custom simulator, you can wrap it:

```typescript
async function mySimulateMCPHost(mcp, scenario, config) {
  if (config.provider === 'my-provider') {
    return mySimulator.simulate(mcp, scenario, config);
  }
  return simulateMCPHost(mcp, scenario, config); // default path
}
```

---

## metadata.expectedToolCalls Migration

The old `toolCallExpectation.ts` module validated tool calls via `evalCase.metadata.expectedToolCalls`. This approach is removed. Use the first-class `expect.toolsTriggered` block instead:

**Before (metadata approach):**

```json
{
  "id": "search-test",
  "mode": "mcp_host",
  "scenario": "Find recent documents",
  "mcpHostConfig": { "provider": "anthropic" },
  "metadata": {
    "expectedToolCalls": [{ "name": "search", "required": true }]
  }
}
```

**After (expect block):**

```json
{
  "id": "search-test",
  "mode": "mcp_host",
  "scenario": "Find recent documents",
  "mcpHostConfig": { "provider": "anthropic" },
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }],
      "order": "any"
    }
  }
}
```

The `expect.toolsTriggered` approach also supports `order: "strict"`, `exclusive: true`, and partial argument matching. See [docs/mcp-host.md](../mcp-host.md) for full details.

---

## For AI Agents Performing This Migration

If you are an AI agent updating a codebase that depends on `@gleanwork/mcp-server-tester`:

1. **Search for removed imports** — grep for `registerAdapter`, `getAdapter`, `hasAdapter`, `runSimulation`, `withRetry`, `isRetryableError`, `LLMAdapter`, `LLMChatResult`, `ExpectedToolCall`, `ToolCallValidationResult`, `ToolCallValidator`, `createToolCallValidator`. Remove all of them.

2. **Update provider dependencies** — if the codebase installs `openai` or `@anthropic-ai/sdk` _only_ for LLM host simulation purposes, replace with `ai @ai-sdk/openai` or `ai @ai-sdk/anthropic`.

3. **Convert metadata.expectedToolCalls** — search for `expectedToolCalls` in eval dataset JSON files and convert to `expect.toolsTriggered` blocks as shown above.

4. **Custom adapters** — if `LLMAdapter` was implemented, rewrite as `MCPHostSimulator` (simpler interface, no conversation loop management).

5. **Verify** — run `npm run typecheck` and `npm test` to confirm the migration is complete.
