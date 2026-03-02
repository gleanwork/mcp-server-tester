# Migration Guide: v0.11.x to v1.0.0

This guide covers the breaking changes introduced in v1.0.0. Most users will only be affected by one or two of these items. Read through the list and apply only the sections relevant to your setup.

## Table of Contents

- [Judge provider alias removed (`'claude'` → `'anthropic'`)](#judge-provider-alias-removed)
- [LLM host: `'ollama'` provider removed](#llm-host-ollama-provider-removed)
- [Assertion accuracy metric renamed (`accuracy` → `assertionPassRate`)](#assertion-accuracy-metric-renamed)
- [Import path improvements (non-breaking)](#import-path-improvements-non-breaking)
- [`env` field added to `StdioMCPConfig` (non-breaking)](#env-field-added-to-stdiomcpconfig-non-breaking)

---

## Judge provider alias removed

**Affects:** `EvalExpectBlock.passesJudge.provider`, `JudgeConfig.provider`

The `'claude'` string alias for the Anthropic judge provider has been removed. Use `'anthropic'` instead.

### Before (v0.11.x)

```typescript
const judge = createJudge({
  provider: 'claude',
  model: 'claude-sonnet-4-20250514',
});
```

```json
{
  "passesJudge": {
    "rubric": "correctness",
    "provider": "claude",
    "threshold": 0.75
  }
}
```

### After (v1.0.0)

```typescript
const judge = createJudge({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
});
```

```json
{
  "passesJudge": {
    "rubric": "correctness",
    "provider": "anthropic",
    "threshold": 0.75
  }
}
```

### How to find affected code

```bash
grep -r '"claude"' evals/ tests/
grep -r "provider: 'claude'" src/ tests/
```

---

## LLM host: `'ollama'` provider removed

**Affects:** Eval datasets and code that set `llmHostConfig.provider: 'ollama'`

The `'ollama'` value was listed in the `LLMProvider` union and accepted by the schema, but the underlying `@ai-sdk/ollama` package does not exist on npm — using it always resulted in a runtime error. The entry has been removed to avoid the misleading impression that it works.

### Mitigation options

**Option 1 — Switch to a supported provider.** If you were using Ollama as a local proxy for another model, configure one of the directly-supported providers instead (`'openai'`, `'anthropic'`, `'google'`, etc.).

**Option 2 — Use the community `ollama-ai-provider` package with a custom simulator.** The `ollama-ai-provider` package on npm provides a Vercel AI SDK-compatible adapter. Implement `LLMHostSimulator` and call it directly:

```typescript
import { createOllama } from 'ollama-ai-provider';
import { generateText } from 'ai';
import type {
  LLMHostSimulator,
  LLMHostSimulationResult,
} from '@gleanwork/mcp-server-tester';

const ollamaSimulator: LLMHostSimulator = {
  async simulate(mcp, scenario, config): Promise<LLMHostSimulationResult> {
    const ollama = createOllama({ baseURL: 'http://localhost:11434/api' });
    const tools = await mcp.listTools();

    const { text, toolCalls } = await generateText({
      model: ollama(config.model ?? 'llama3'),
      prompt: scenario,
      tools: buildVercelTools(tools, mcp),
      maxSteps: config.maxSteps ?? 10,
    });

    return {
      success: true,
      toolCalls: toolCalls.map(normalizeToolCall),
      response: text,
    };
  },
};
```

See [docs/llm-host.md](../llm-host.md) for the `LLMHostSimulator` interface details.

---

## Assertion accuracy metric renamed

**Affects:** Code that reads `EvalCaseResult.accuracy` programmatically.

The `accuracy` field on `EvalCaseResult` has been renamed to `assertionPassRate` to better reflect what it measures (the fraction of assertion checks that passed within a multi-iteration run). The old name still exists as a deprecated alias and will be removed in v2.0.

### Before (v0.11.x)

```typescript
const result = await runEvalDataset({ dataset }, { mcp, testInfo });

for (const caseResult of result.caseResults) {
  console.log(`${caseResult.id}: accuracy = ${caseResult.accuracy}`);
}
```

### After (v1.0.0)

```typescript
const result = await runEvalDataset({ dataset }, { mcp, testInfo });

for (const caseResult of result.caseResults) {
  console.log(`${caseResult.id}: pass rate = ${caseResult.assertionPassRate}`);
}
```

The `accuracy` field still returns the same value for now — update at your convenience, but do not rely on it beyond v1.x.

---

## Import path improvements (non-breaking)

This is not a breaking change. The top-level export now re-exports everything previously only available from subpath exports. Your existing imports continue to work without modification.

### What changed

`test` and other fixture helpers that previously required the subpath import are now available from the package root:

```typescript
// Previously required — still works
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';

// Now also works — preferred for new code
import { test } from '@gleanwork/mcp-server-tester';
```

The subpath exports (`/fixtures/mcp`, `/fixtures/mcpAuth`, `/reporters/mcpReporter`) remain in place and continue to work.

---

## `env` field added to `StdioMCPConfig` (non-breaking)

This is not a breaking change. No action is required unless you want to use the new field.

`StdioMCPConfig` now accepts an optional `env` field — a `Record<string, string>` that is merged with `process.env` when the stdio subprocess is spawned. This is useful for injecting secrets or configuration without modifying your shell environment.

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    {
      name: 'my-server',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['./server.js'],
          env: {
            MY_SERVER_API_KEY: process.env.MY_SERVER_API_KEY ?? '',
            LOG_LEVEL: 'warn',
          },
        },
      },
    },
  ],
});
```

Variables in `env` override the corresponding `process.env` values for the child process only.
