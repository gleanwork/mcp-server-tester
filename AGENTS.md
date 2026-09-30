# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

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

- **`config/`** - `MCPConfig` types and Zod validation for stdio/HTTP transports, `protocolMatrix()`
- **`mcp/`** - Client factory (`createMCPClientForConfig`), fixtures (`MCPFixtureApi`), protocol selection (`protocol.ts`), wire tap, and response normalization. Built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/client`)
- **`skills/`** - Agent Skills over MCP (SEP-2640): wire schemas, entry validation, and a skills client (the SDK has no skills API yet)
- **`auth/`** - OAuth 2.1 with PKCE (`PlaywrightOAuthClientProvider`) and static token utilities
- **`assertions/`** - Unified assertion architecture (see below)
- **`evals/`** - Dataset types, loader, and runner (uses validators internally). `evals/caseExecution.ts` is the only place a case runs: every path (direct tool/request, simulated `mcp_host`, `external_host`, suite hosts) returns a typed `CaseExecution`, and the runner reads its fields instead of inspecting `response`. `caseExecution.golden.test.ts` pins the resulting `EvalCaseResult` for every path
- **`judge/`** - LLM-as-a-judge via Claude Agent SDK
- **`spec/`** - Conformance check registry (`checks/core.ts`, `checks/modern.ts`, `checks/skills.ts`), raw probe channel, and cross-era checks
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
| `toHaveToolCalls(expectation)`           | LLM called the expected tools (mcp_host mode) |
| `toHaveToolCallCount(options)`           | LLM made N tool calls (mcp_host mode)         |

### Playwright Fixtures (`src/fixtures/mcp.ts`)

The main test fixture provides:

- `mcpClient: Client` - Raw MCP SDK client
- `mcp: MCPFixtureApi` - High-level test API with `listTools()`, `callTool()`, `protocol`, `discover()`, `listResources()`, `readResource()`, `request()`, and `skills`

Configuration is read from `project.use.mcpConfig` in playwright.config.ts. The `mcpProtocol` option overrides `mcpConfig.protocol`.

### Protocol Versions

`mcpConfig.protocol` selects the MCP protocol: `'legacy'` (default; the `initialize` handshake, byte-identical to 1.x and guarded by `src/mcp/wireCompat.test.ts`), `'auto'`, or a revision such as `'2025-06-18'` or `'2026-07-28'`. `protocolMatrix(project, protocols)` expands a Playwright project per protocol. This repo's own `playwright.config.ts` runs the specs across `dual-stdio@{legacy,2025-06-18,2026-07-28,auto}` and `dual-http@{legacy,2026-07-28}` against `tests/mocks/dualEraServer.ts`. See `docs/protocol-versions.md`.

`mcp.callTool()` folds JSON-RPC protocol errors (e.g. `-32602` unknown tool) into an `isError` result (`callToolNormalized`); local SDK errors still throw.

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
  "mode": "mcp_host",
  "scenario": "Find recent docs about planning",
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

- `iterations`: Run case N times (default: 1). When > 1, result has `assertionPassRate` (0-1) and `iterationResults[]`
- `accuracyThreshold`: Minimum accuracy to pass (default: 1.0)

### Concurrency

Run multiple eval cases in parallel:

```typescript
await runEvalDataset({ dataset, concurrency: 4 }, { mcp, testInfo });
```

### Tool Call Assertions (mcp_host mode only)

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

### Testing Modes

The framework supports two evaluation modes:

- **Direct mode** (`mode: 'direct'`, default): Call a specific tool with known arguments and assert on the response. Fast, deterministic, free. Use for regression testing.
- **mcp_host mode** (`mode: 'mcp_host'`): An LLM receives a natural language `scenario` and discovers which tools to call. Non-deterministic, costs money, measures tool description quality. Use selectively for tool discoverability validation.

Direct mode uses `toolName` + `args`, or `request: { method, params }` for any MCP request (e.g. `skills/get`). mcp_host mode uses `scenario` + `mcpHostConfig`; `mcpHostConfig.skills: 'catalog' | 'preload'` lets the SDK host offer the server's Agent Skills (skills the model loads are `kind: 'skill'` events for `toolsTriggered`; preloads are not). Tool call assertions (`toolsTriggered`, `toolCallCount`) only work in mcp_host mode.

### Snapshot Testing

`toMatchToolSnapshot(name, sanitizers?)` compares tool responses against saved baselines. Requires Playwright `testInfo` (destructure from second arg: `async ({ mcp }, testInfo)`).

Built-in sanitizers: `'uuid'`, `'iso-date'`, `'timestamp'`, `'jwt'`, `'objectId'`

Custom sanitizers:

- Field removal: `{ remove: ['createdAt', 'requestId'] }`
- Regex replacement: `{ pattern: /token_[a-z0-9]+/, replacement: '[TOKEN]' }`

Update snapshots: `npx playwright test --update-snapshots`

### MCP Host Simulation

`simulateMCPHost()` orchestrates LLM + MCP tool calls via the Vercel AI SDK. The LLM receives all available tools and a scenario prompt, then decides which tools to call.

Two host types:

- **`sdk`** (default): Programmatic via Vercel AI SDK. Reuses the test's MCP connection. Requires `provider`.
- **`cli`**: CLI-based hosts (e.g., Claude Code). Spawns a process with its own MCP connection. Requires `cli` config with `command`, `args` (use `{{scenario}}` placeholder), and `outputFormat`.

Provider packages are dynamically imported — install `ai` + `@ai-sdk/<provider>` (e.g., `npm install ai @ai-sdk/anthropic`).

Multi-iteration: set `iterations` and `accuracyThreshold` on an eval case. The runner executes N times, computes `assertionPassRate` (0–1), and passes if rate >= threshold.

### Fixture Composition

- **Standard**: `import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp'` — provides `mcp: MCPFixtureApi` and `mcpClient: Client`
- **Manual**: `createMCPFixture(client, testInfo?, options?)` — for custom fixture hierarchies or non-Playwright usage
- **Auth**: `import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth'` — adds OAuth/token auth setup
- Always call `closeMCPClient(client)` in teardown when using manual fixtures

### Conformance Checking

`runConformanceChecks(mcp)` validates MCP protocol compliance for the negotiated era. Checks are definitions in `src/spec/checks/` with `eras`, `severity` ('must' fails the result, 'should' is a warning), and `specRef`. Legacy connections run the core checks unchanged from 1.x; 2026-07-28 connections add the modern checks (some send raw probes via `src/spec/probe.ts`; `probe: false` skips them); servers declaring the skills extension get the skills checks in every era. `runCrossEraChecks(config)` compares what a server serves across protocols. Attach results to the reporter via `testInfo`.

To add a check: add a `ConformanceCheckDefinition` to the right file in `src/spec/checks/`, and prove it with a failing server. `tests/mocks/rawModernServer.mjs` (`FAULTS=...`) and `tests/mocks/mockSkills.ts` (`MOCK_SKILL_FAULTS=...`) switch on individual spec violations.

### Judge / Rubrics

`toPassToolJudge(rubric, options?)` sends the tool response to an LLM for quality evaluation. Requires `await`.

Built-in rubrics: `'correctness'`, `'completeness'`, `'groundedness'`, `'instruction-following'`, `'conciseness'`

Custom rubrics: pass a string prompt or `{ text: '...' }` object. Use `judgeReps` (case-level) or `reps` (assertion-level) for variance reduction — scores are averaged across repetitions.

`registerJudge(name, executor)` registers a custom judge for use with `{ judge: 'name' }` in `toPassToolJudge` or `passesJudge` eval expectations.

### Debugging

- `DEBUG=mcp-server-tester:*` enables verbose logging for transport, auth, and eval runner internals
- Common pitfalls:
  - Missing `testInfo` for snapshot matchers (destructure from second test arg)
  - Wrong import path — use `@gleanwork/mcp-server-tester/fixtures/mcp` for tests, not the root path
  - Provider package not installed for mcp_host mode (`npm install ai @ai-sdk/<provider>`)
  - Missing `await` on async matchers (`toPassToolJudge`, `toMatchToolSnapshot`, `toSatisfyToolPredicate`)
  - Importing from `@modelcontextprotocol/sdk` (v1): use `@modelcontextprotocol/client` (types, transports, auth) or `@modelcontextprotocol/server` (mock servers)
  - Pinning `protocol: '2026-07-28'` against a legacy-only server fails by design; use `'legacy'` or `'auto'`

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

## Pre-Push Checklist

Before pushing commits or creating a PR, run all CI checks locally and fix any failures. These mirror the CI pipeline (`.github/workflows/ci.yml`) exactly. Build before typecheck and lint: legacy examples resolve package self-imports through `dist`.

```bash
npm run format:check        # Prettier (run `npm run format` to auto-fix)
npm run build               # Full build including UI reporter
npm run typecheck           # TypeScript validation
npm run lint                # ESLint (run `npm run lint:fix` to auto-fix)
npm run docs:check          # Docs snippet sync
npm run test:eval-foundation # Public evaluation foundation contracts
npm test                    # Unit tests (Vitest)
npx playwright install --with-deps
npm run test:playwright     # Integration tests (Playwright)
```

If `format:check` or `lint` fails, run `npm run format` or `npm run lint:fix` to auto-fix, then re-check. If `docs:check` fails with "content-mismatch", update the snippet line range in the markdown file to match the current source.

**Keep in sync:** If `.github/workflows/ci.yml` changes, update this checklist to match.

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

### New LLM Host Provider (mcp_host mode)

Supported `LLMProvider` values for `mcpHostConfig.provider` (defined in `src/evals/mcpHost/mcpHostTypes.ts`):

`'openai' | 'anthropic' | 'azure' | 'google' | 'mistral' | 'deepseek' | 'openrouter' | 'xai' | 'vertex-anthropic'`

To add a new provider:

1. Add to `LLMProvider` union in `src/evals/mcpHost/mcpHostTypes.ts`
2. Add to `ProviderSchema` in `src/evals/mcpHost/hostOptions.ts` (the dataset schema and the simulator's supported set derive from it)
3. Create an adapter in `src/evals/mcpHost/adapters/`
4. Register in `src/evals/mcpHost/adapter.ts`

### New Transport Type

1. Add to `MCPConfig` union in `src/config/mcpConfig.ts`
2. Update `createMCPClientForConfig()` in `src/mcp/clientFactory.ts`

### New Auth Provider

1. Implement the `OAuthClientProvider` interface from `@modelcontextprotocol/client`
2. Add utilities to `src/auth/` module
3. Export from `src/index.ts`
