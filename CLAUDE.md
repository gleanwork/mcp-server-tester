# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@gleanwork/mcp-server-tester` is a Playwright-based testing and evaluation framework for Model Context Protocol (MCP) servers. It provides Playwright fixtures for automated testing and data-driven eval datasets with optional LLM-as-a-judge scoring.

## Common Commands

```bash
# Build (includes UI reporter build)
npm run build

# Unit tests (Vitest)
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npm test -- src/mcp/clientFactory.test.ts  # Run single test file
npm test -- -t "creates client"            # Run tests matching pattern

# Integration tests (Playwright)
npm run test:playwright

# Code quality
npm run typecheck           # TypeScript validation
npm run lint                # ESLint
npm run lint:fix            # Auto-fix lint issues
npm run format              # Prettier formatting
npm run format:check        # Check formatting
```

## Architecture

### Core Modules (`src/`)

- **`config/`** - `MCPConfig` types and Zod validation for stdio/HTTP transports
- **`mcp/`** - Client factory (`createMCPClientForConfig`), fixtures (`MCPFixtureApi`), and response normalization
- **`auth/`** - OAuth 2.1 with PKCE (`PlaywrightOAuthClientProvider`) and static token utilities
- **`assertions/`** - Unified assertion architecture (see below)
- **`evals/`** - Dataset types, loader, and runner (uses validators internally)
- **`judge/`** - LLM-as-a-judge via Claude Agent SDK
- **`spec/`** - MCP protocol conformance checks
- **`reporters/`** - Custom Playwright reporter with React-based UI
- **`cli/`** - `mcp-server-tester init` and `mcp-server-tester generate` commands

### Assertions Module (`src/assertions/`)

The assertion architecture provides a single API for both inline tests and data-driven evals:

- **`validators/`** - Pure validation functions: `validateText`, `validateSchema`, `validatePattern`, `validateError`, `validateSize`, `validateResponse`, `validateToolCalls`, `validateToolCallCount`
- **`matchers/`** - Playwright custom matchers (see table below)

```typescript
// Inline test usage
import { expect } from '@gleanwork/mcp-server-tester';

test('weather tool', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toContainToolText('temperature');
  expect(result).toMatchToolSchema(WeatherSchema);
  expect(result).not.toBeToolError();
});

// Programmatic validation
import { validateText } from '@gleanwork/mcp-server-tester';

const result = validateText(response, ['temperature']);
if (!result.pass) console.log(result.message);
```

### Available Matchers

| Matcher                                  | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `toMatchToolResponse(expected)`          | Exact response match (deep equal)             |
| `toContainToolText(text)`                | Response contains text substring(s)           |
| `toMatchToolPattern(pattern)`            | Response matches regex pattern(s)             |
| `toMatchToolSchema(schema)`              | Response validates against Zod schema         |
| `toMatchToolSnapshot(name, sanitizers?)` | Response matches saved snapshot               |
| `toBeToolError(expected?)`               | Response is (or is not) an error              |
| `toPassToolJudge(rubric, options?)`      | Response passes LLM-as-judge evaluation       |
| `toHaveToolResponseSize(options)`        | Response size is within bounds                |
| `toSatisfyToolPredicate(fn, desc?)`      | Response satisfies custom predicate           |
| `toHaveToolCalls(expectation)`           | LLM called the expected tools (llm_host mode) |
| `toHaveToolCallCount(options)`           | LLM made N tool calls (llm_host mode)         |

### Playwright Fixtures (`src/fixtures/mcp.ts`)

The main test fixture provides:

- `mcpClient: Client` - Raw MCP SDK client
- `mcp: MCPFixtureApi` - High-level test API with `listTools()`, `callTool()`, etc.

Configuration is read from `project.use.mcpConfig` in playwright.config.ts.

### Exports

Public API is defined in `src/index.ts`. The package has multiple export paths:

- `.` - Main library exports
- `./fixtures/mcp` - Playwright test fixtures
- `./fixtures/mcpAuth` - Auth-specific fixtures for OAuth/token auth
- `./reporters/mcpReporter` - Custom reporter

### Multi-Iteration Accuracy

Eval cases can be run multiple times to compute accuracy (win rate):

```json
{
  "id": "search-trigger",
  "mode": "llm_host",
  "scenario": "Find recent docs about planning",
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

- `iterations`: Run case N times (default: 1). When > 1, result has `accuracy` (0-1) and `iterationResults[]`
- `accuracyThreshold`: Minimum accuracy to pass (default: 1.0)

### Concurrency

Run multiple eval cases in parallel:

```typescript
await runEvalDataset({ dataset, concurrency: 4 }, { mcp, testInfo });
```

### Tool Call Assertions (llm_host mode only)

```json
"expect": {
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }],
    "order": "any",
    "exclusive": false
  },
  "toolCallCount": { "min": 1, "max": 5 }
}
```

Validators: `validateToolCalls(response, expectation)`, `validateToolCallCount(response, options)`

## Type Architecture

### Single Source of Truth

Types are organized in a canonical hierarchy to prevent duplication and drift:

- **`src/types/index.ts`** - Core shared types: `AuthType`, `ResultSource`, `ExpectationType`, `EvalExpectationResult`
- **`src/types/reporter.ts`** - Reporter-specific types: `MCPEvalRunData`, `EvalCaseResult`, `MCPConformanceResultData`, `MCPServerCapabilitiesData`

### Import Guidelines

1. **For new code**: Always import from `src/types/` first
2. **For existing modules**: Import from their own domain, which re-exports from canonical source
3. **Never define** `AuthType`, `ExpectationType`, or other core types inline - import them

```typescript
// Correct: Import from canonical source
import type { AuthType, ExpectationType } from '../types/index.js';

// Correct: Import from domain module (which re-exports)
import type { EvalCaseResult } from '../types/reporter.js';

// Wrong: Inline type literal
authType?: 'oauth' | 'api-token' | 'none';  // Don't do this!
```

### UI Type Synchronization

`src/reporters/ui-src/types.ts` re-exports all types directly from the canonical backend sources (`src/types/index.ts` and `src/types/reporter.ts`). No manual sync is required — update `src/types/reporter.ts` and the UI automatically picks up the changes.

## Code Style

- Use function declarations, not arrow function expressions for exports
- Use explicit `null` in ternaries instead of short-circuit (`condition ? 'value' : null`)
- Descriptive type names (e.g., `EvalDataset`, `MCPFixtureApi`, `Judge`, `ValidationResult`)
- No `any` types - TypeScript strict mode is enabled
- Keep `async` keyword even if no `await` currently used

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Adding New Features

### New Validator

1. Create `src/assertions/validators/myValidator.ts` returning `ValidationResult`
2. Export from `src/assertions/validators/index.ts`
3. Add unit tests in `src/assertions/validators/validators.test.ts`

### New Matcher

1. Create `src/assertions/matchers/toMyMatcher.ts` using a validator
2. Import and add to the single `expect.extend({})` call in `src/assertions/matchers/index.ts`
3. Add TypeScript declaration in `src/assertions/matchers/types.ts` (inside the `PlaywrightTest.Matchers` interface)
4. Export from `src/index.ts`

### New LLM Judge Provider

1. Add to `ProviderKind` in `src/judge/judgeTypes.ts`
2. Implement `Judge` interface in `src/judge/myProviderJudge.ts`
3. Add to switch in `src/judge/judgeClient.ts`

### New LLM Host Provider (llm_host mode)

Supported `LLMProvider` values for `llmHostConfig.provider` (defined in `src/evals/llmHost/llmHostTypes.ts`):

`'openai' | 'anthropic' | 'azure' | 'google' | 'mistral' | 'ollama' | 'deepseek' | 'openrouter' | 'xai'`

To add a new provider:

1. Add to `LLMProvider` union in `src/evals/llmHost/llmHostTypes.ts`
2. Add to the `provider` enum in `LLMHostConfigSchema` in `src/evals/datasetTypes.ts`
3. Create an adapter in `src/evals/llmHost/adapters/`
4. Register in `src/evals/llmHost/adapter.ts`

### New Transport Type

1. Add to `MCPConfig` union in `src/config/mcpConfig.ts`
2. Update `createMCPClientForConfig()` in `src/mcp/clientFactory.ts`

### New Auth Provider

1. Implement `OAuthClientProvider` interface from `@modelcontextprotocol/sdk/client/auth.js`
2. Add utilities to `src/auth/` module
3. Export from `src/index.ts`
