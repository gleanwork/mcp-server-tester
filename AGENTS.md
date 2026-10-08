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
- **`mcp/`** - Client factory (`createMCPClientForConfig`), fixtures (`MCPFixtureApi`), protocol selection (`protocol.ts`), wire tap, and response normalization. Built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/client`). `mcp/connection.ts` is the one record of what MST knows about a client it created (requested protocol, connection target for raw probes, wire tap, owned undici agent); read it with `connectionOf(client)`, and add new per-connection facts there rather than in a new side table
- **`skills/`** - Agent Skills over MCP (SEP-2640): wire schemas, entry validation, and a skills client (the SDK has no skills API yet)
- **`auth/`** - OAuth 2.1 with PKCE (`PlaywrightOAuthClientProvider`) and static token utilities
- **`assertions/`** - Unified assertion architecture (see below)
- **`evals/`** - Dataset types, loader, and runner (uses validators internally). `evals/caseExecution.ts` is the only place a case runs: every path (the `mst` client on a Playwright test's connection, an eval's client, a custom `executeCase`) returns a typed `CaseExecution` (`completed` or `failed`), and the runner reads its fields instead of inspecting `response`. `caseExecution.golden.test.ts` pins the resulting `EvalCaseResult` for every path. `evals/grading.ts` grades a case's `assertions` block: it decides once whether the evidence can support tool-call assertions (`toolEvidenceGap`), builds the `toolCallTrace` view, resolves judge settings (including suite eval config judges), then calls the validators. Desktop hosts (Cowork, ChatGPT) run batches through `evals/desktopBatch.ts` (lease, per-case reset policy, native-session ledger, redaction, cleanup) and share one MCP readiness rule (`isMcpServerReady` in `evals/mcpReadiness.ts`); a new desktop host supplies only prepare, one case, reset and dispose. macOS Swift controllers build and run through `evals/nativeHelper.ts`, which owns their environment policy
- **`llm/`** - `resolveLLMEndpoint()`: the one place MST's own LLM calls (SDK client, judges) get their base URL and credential, including gateway bearer tokens and `MST_LLM_AUTH_COMMAND`. New LLM consumers resolve through it rather than reading `*_API_KEY` themselves. See `docs/llm-gateways.md`
- **`judge/`** - LLM-as-a-judge via Claude Agent SDK
- **`plugins/`** - ESLint-style plugins: the `Plugin` shape and validation (`plugin.ts`), the process-wide extension table keyed by `<namespace>/<kind>/<name>` (names parsed and kind-checked in `plugin.ts` and `extensions.ts`), where each kind's lookup (next to its built-ins) adds them under bare names (`extensions.ts`), and the loader (`loadPlugins.ts`). `evals/evalPlugins.ts` loads an eval's plugins and checks it only references namespaces it loads. Domain terms are in `CONTEXT.md`; decisions in `docs/adr/`
- **`spec/`** - Conformance check registry (`checks/core.ts`, `checks/modern.ts`, `checks/skills.ts`), raw probe channel, and cross-era checks
- **`reporters/`** - Custom Playwright reporter with React-based UI. `reporters/channel.ts` owns every attachment the reporter reads (names, payload types, read-side Zod schemas). Write with `attachReporterData(testInfo, { kind, data })`, never `testInfo.attach('mcp-...')` directly
- **`cli/`** - The CLI, shipped as `mst` and `mcp-server-tester` (the same binary): `init`, `generate`, `login`, `token`, `run`, `batch`, `cowork`, `open`

### Assertions Module (`src/assertions/`)

The assertion architecture provides a single API for both inline tests and data-driven evals:

- **`validators/`** - Pure validation functions: `validateText`, `validateSchema`, `validatePattern`, `validateError`, `validateSize`, `validateResponse`, `validateToolCalls`, `validateToolCallCount`, `validateJudge`, `validateSnapshot`, `validatePredicate`
- **`matchers/`** - Playwright custom matchers (see table below). Each is a thin adapter over a validator: it returns the validator's `pass` and lets Playwright apply `.not` (never negate inside a matcher)

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

| Matcher                                  | Purpose                                 |
| ---------------------------------------- | --------------------------------------- |
| `toMatchToolResponse(expected)`          | Exact response match (deep equal)       |
| `toContainToolText(text)`                | Response contains text substring(s)     |
| `toMatchToolPattern(pattern)`            | Response matches regex pattern(s)       |
| `toMatchToolSchema(schema)`              | Response validates against Zod schema   |
| `toMatchToolSnapshot(name, sanitizers?)` | Response matches saved snapshot         |
| `toBeToolError(expected?)`               | Response is (or is not) an error        |
| `toPassToolJudge(rubric, options?)`      | Response passes LLM-as-judge evaluation |
| `toHaveToolResponseSize(options)`        | Response size is within bounds          |
| `toSatisfyToolPredicate(fn, desc?)`      | Response satisfies custom predicate     |
| `toHaveToolCalls(assertion)`             | The client called the expected tools    |
| `toHaveToolCallCount(options)`           | The client made N tool calls            |

### Playwright Fixtures (`src/fixtures/mcp.ts`)

The main test fixture provides:

- `mcpClient: Client` - Raw MCP SDK client
- `mcp: MCPFixtureApi` - High-level test API with `listTools()`, `callTool()`, `protocol`, `discover()`, `listResources()`, `readResource()`, `request()`, and `skills`

Configuration is read from `project.use.mcpConfig` in playwright.config.ts. The `mcpProtocol` option overrides `mcpConfig.protocol`.

### Protocol Versions

`mcpConfig.protocol` selects the MCP protocol: `'legacy'` (default; the `initialize` handshake, byte-identical to 1.x and guarded by `src/mcp/wireCompat.test.ts`), `'auto'`, or a revision such as `'2025-06-18'` or `'2026-07-28'`. `protocolMatrix(project, protocols)` expands a Playwright project per protocol. This repo's own `playwright.config.ts` runs the specs across `dual-stdio@{legacy,2025-06-18,2026-07-28,auto}` and `dual-http@{legacy,2026-07-28}` against `tests/mocks/dualEraServer.ts`. See `docs/protocol-versions.md`.

`mcp.callTool()` folds JSON-RPC protocol errors (e.g. `-32602` unknown tool) into an `isError` result (`callToolNormalized`); local SDK errors still throw.

### Exports

The public API is tiered. Each name is exported from exactly one of these entry points (`./types` additionally re-exports the root's shared types without runtime code):

- `.` (`src/index.ts`) - The core testing interface: fixtures, matchers and validators, MCP client, config, datasets with `runEvalDataset`/`runEvalCase`, judges, conformance, skills, and their types
- `./evals` (`src/entries/evals.ts`) - The evaluation framework: eval configs, evals/batches, extension definition types, metrics, result stores, comparisons, tool optimizations
- `./auth` (`src/entries/auth.ts`) - Low-level OAuth: discovery, token storage, client credentials
- `./experimental/clients` (`src/entries/experimentalClients.ts`) - Desktop-run metadata types, Cowork settings and audit, client plugins (may change between minors)
- `./fixtures/mcp`, `./fixtures/mcpAuth`, `./reporters/mcpReporter` - Playwright fixtures and the reporter

The subpaths are ESM only and share chunks with the ESM root (tsup `splitting`), so module state (the extension table, classes) is one instance across them. The CommonJS root and the fixtures/reporter bundles are separate copies; only `Symbol.for` state (the extension table and the plugin-load cache) is shared with those. New public names go in the narrowest tier that fits. `npm run knip` (in CI) fails on files, exports or dependencies nothing uses, so delete dead code rather than leaving it exported. `src/publicApi.test.ts` pins each entry point's runtime exports: after a deliberate change, update it with `npx vitest run src/publicApi.test.ts -u` and note any removal in the migration guides. Tests count as users, so an export only a test imports is not flagged.

### Trials and Pass Rate

Eval cases can run several trials to compute a pass rate:

```json
{
  "id": "search-trigger",
  "input": "Find recent docs about planning",
  "trials": 5,
  "passThreshold": 0.8,
  "assertions": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    }
  }
}
```

- `trials`: Run case N times (default: 1). When > 1, result has `passRate` (0-1) and `trialResults[]`
- `passThreshold`: Minimum share of trials that must pass (default: 1.0)

### Concurrency

Run multiple eval cases in parallel:

```typescript
await runEvalDataset(
  { dataset, client: 'mst', model: 'claude-haiku-4-5', concurrency: 4 },
  { mcp, testInfo }
);
```

### Tool Call Assertions

```json
"assertions": {
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }],
    "order": "any",
    "exclusive": false
  },
  "toolCallCount": { "min": 1, "max": 5 }
}
```

Validators: `validateToolCalls(response, assertion)`, `validateToolCallCount(response, options)`

### Tests and Evals

- **Tool tests** are Playwright tests: `mcp.callTool(name, args)` (or `mcp.request(method, params, schema)`) and the matchers. Fast, deterministic, free. Use for regression testing. `mst generate` writes them as a spec. There are no direct eval cases: `toolName`, `args`, `request` and `mode` on a case fail with what replaces them, as do the tool-response assertions (`response`, `schema`, `snapshot`, `isError`, `responseSize`).
- **Evals** run every case (`input` + `assertions`) on a client and its model. Non-deterministic, costs money, measures tool description quality. In a Playwright test, `runEvalDataset({ dataset, client: 'mst', model })` runs cases on the `mst` client over the test's connection; other clients (`claude-code`, `cowork`, `chatgpt`, plugins) run in suites (`mst run`). A case can set its own `client`, `model` and `clientOptions`. The `mst` client's `skills: 'catalog' | 'preload'` option offers the server's Agent Skills (skills the model loads are `kind: 'skill'` events for `toolsTriggered`; preloads are not).

### Snapshot Testing

`toMatchToolSnapshot(name, sanitizers?)` compares tool responses against saved baselines. Requires Playwright `testInfo` (destructure from second arg: `async ({ mcp }, testInfo)`). The matcher runs `validateSnapshot` against `playwrightSnapshotStore(expect)`; unit tests pass their own `SnapshotStore`. This repo's own snapshots live in `tests/__snapshots__/` (platform-free `snapshotPathTemplate`), exercised by `tests/snapshot.spec.ts`.

Built-in sanitizers: `'uuid'`, `'iso-date'`, `'timestamp'`, `'jwt'`, `'objectId'`

Custom sanitizers:

- Field removal: `{ remove: ['createdAt', 'requestId'] }`
- Regex replacement: `{ pattern: /token_[a-z0-9]+/, replacement: '[TOKEN]' }`

Update snapshots: `npx playwright test --update-snapshots`

### The mst and claude-code Clients

`simulateMstClient()` (internal, in `src/evals/mstClient/`) runs the `mst` and `claude-code` clients: the `sdk` path drives a model through the Vercel AI SDK over the test's MCP connection; the `cli` path spawns Claude Code with its own connection. Tests and evals reach it only through `runEvalDataset`/`runEvalCase` or an eval. The external-client runtime in `src/evals/externalClient/` is likewise internal to the ChatGPT client; `./experimental/clients` exports only the metadata types results carry.

Provider packages are dynamically imported — install `ai` + `@ai-sdk/<provider>` (e.g., `npm install ai @ai-sdk/anthropic`).

Multiple trials: set `trials` and `passThreshold` on an eval case. The runner executes N times, computes `passRate` (0–1), and passes if rate >= threshold.

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

Custom judges come from plugins: a plugin's `judges: { completeness: { schema, evaluate } }` is used as `{ judge: 'acme/judge/completeness' }` in `toPassToolJudge` or `passesJudge`. Pass plugins with `test.use({ mcpPlugins: [plugin] })`, `runEvalDataset({ dataset, plugins })`, or an eval config's `plugins`.

### Debugging

- `DEBUG=mcp-server-tester:*` enables verbose logging for transport, auth, and eval runner internals
- Common pitfalls:
  - Missing `testInfo` for snapshot matchers (destructure from second test arg)
  - Wrong import path — use `@gleanwork/mcp-server-tester/fixtures/mcp` for tests, not the root path
  - Provider package not installed for the `mst` client (`npm install ai @ai-sdk/<provider>`)
  - Missing `await` on async matchers (`toPassToolJudge`, `toMatchToolSnapshot`, `toSatisfyToolPredicate`)
  - Importing from `@modelcontextprotocol/sdk` (v1): use `@modelcontextprotocol/client` (types, transports, auth) or `@modelcontextprotocol/server` (mock servers)
  - Pinning `protocol: '2026-07-28'` against a legacy-only server fails by design; use `'legacy'` or `'auto'`

## Type Architecture

### Single Source of Truth

Types are organized in a canonical hierarchy to prevent duplication and drift:

- **`src/types/index.ts`** - Core shared types: `AuthType`, `ResultSource`, `GraderType`, `GraderScore`
- **`src/types/reporter.ts`** - Reporter-specific types: `MCPEvalRunData`, `EvalCaseResult`, `MCPConformanceResultData`, `MCPServerCapabilitiesData`

### Import Guidelines

1. **For new code**: Always import from `src/types/` first
2. **For existing modules**: Import from their own domain, which re-exports from canonical source
3. **Never define** `AuthType`, `GraderType`, or other core types inline - import them

```typescript
// Correct: Import from canonical source
import type { AuthType, GraderType } from '../types/index.js';

// Correct: Import from domain module (which re-exports)
import type { EvalCaseResult } from '../types/reporter.js';

// Wrong: Inline type literal
authType?: 'oauth' | 'api-token' | 'none';  // Don't do this!
```

### UI Type Synchronization

`src/reporters/ui-src/types.ts` re-exports the types the UI uses directly from the canonical backend sources (`src/types/index.ts` and `src/types/reporter.ts`), so shapes never drift. When a component needs another type, add its re-export there; knip flags re-exports the UI doesn't use.

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
npm run knip                # Unused files, exports and dependencies
npm run docs:check          # Docs snippet sync
npm run test:eval-foundation # Public evaluation foundation contracts
npm run test:eval-review    # CLI smoke
npm run test:usecases       # Use cases through the CLI (tests/usecases)
npm test                    # Unit tests (Vitest)
npx playwright install --with-deps
npm run test:playwright     # Integration tests (Playwright)
```

If `format:check` or `lint` fails, run `npm run format` or `npm run lint:fix` to auto-fix, then re-check. If `docs:check` fails with "content-mismatch", update the snippet line range in the markdown file to match the current source.

**Keep in sync:** If `.github/workflows/ci.yml` changes, update this checklist to match.

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Adding New Features

### New Built-in Extension (dataset source, client, judge, metric, result store)

Add it to the kind's built-in record, keyed by its bare name: `builtinDatasetSources()`, `builtinClientDefinitions()`, `builtinJudges()` (`src/judge/builtinJudges.ts`), `BUILT_IN_METRICS`, or `builtinResultStores()`. Each kind's lookup (`getClient`, `getJudge`, ...) lives next to that record and installs it on first use; the extension table (`src/plugins/extensions.ts`) knows no built-ins. Organization-specific extensions belong in a plugin, not here.

### New Validator

1. Create `src/assertions/validators/myValidator.ts` returning `ValidationResult`
2. Export from `src/assertions/validators/index.ts`
3. Add unit tests in `src/assertions/validators/validators.test.ts`, or in `myValidator.test.ts` when they need their own fixtures (as `snapshot.test.ts`, `judge.test.ts` and `toolCalls.test.ts` do)

### New Assertion Type (eval datasets)

1. Write the validator (see above)
2. Add the field to `EvalAssertionsSchema` in `src/evals/datasetTypes.ts`, and its result key to `GraderType` in `src/types/index.ts`
3. Add one branch to `gradeTrial()` in `src/evals/grading.ts`, and a case to `src/evals/grading.test.ts`

### New Matcher

1. Create `src/assertions/matchers/toMyMatcher.ts` using a validator
2. Import and add to the single `assertions.extend({})` call in `src/assertions/matchers/index.ts`
3. Add TypeScript declaration in `src/assertions/matchers/types.ts` (inside the `PlaywrightTest.Matchers` interface)
4. Export from `src/index.ts` (the root tier)

### New LLM Judge Provider

1. Add to `JUDGE_PROVIDER_KINDS` in `src/judge/judgeTypes.ts` (`ProviderKind` and the dataset schema derive from it)
2. Write a completion adapter in `src/judge/myProviderJudge.ts`: `(config: JudgeConfig) => JudgeCompletionAdapter`, which sends `{ system, prompt }` and returns `{ text, usage }`. Load the SDK with `loadJudgeSdk(() => import('pkg'), ...)` from `src/judge/adapterSupport.ts`, and type only the SDK surface you read (no `any`). Don't build prompts or parse verdicts there: `src/judge/llmJudge.ts` owns the prompt, the parser, the `maxToolOutputSize` guard and usage defaults for every provider. For an Anthropic- or OpenAI-shaped API, check the credential up front with `requireJudgeCredential` and resolve the endpoint per call with `resolveLLMEndpoint` (`src/llm/endpoint.ts`), so gateways work
3. Add it to `JUDGE_PROVIDERS` in `src/judge/judgeClient.ts` (the record is typed by `ProviderKind`, so a missing entry is a compile error)

### New LLM Client Provider (the mst client)

Supported `LLMProvider` values for the `mst` client's `provider` option (defined in `src/evals/mstClient/types.ts`):

`'openai' | 'anthropic' | 'azure' | 'google' | 'mistral' | 'deepseek' | 'openrouter' | 'xai' | 'vertex-anthropic'`

To add a new provider:

1. Add to `LLMProvider` union in `src/evals/mstClient/types.ts`
2. Add to `ProviderSchema` in `src/evals/mstClient/clientOptions.ts` (the dataset schema and the simulator's supported set derive from it)
3. Create an adapter in `src/evals/mstClient/adapters/`
4. Register in `src/evals/mstClient/adapter.ts`

### New Transport Type

1. Add to `MCPConfig` union in `src/config/mcpConfig.ts`
2. Update `createMCPClientForConfig()` in `src/mcp/clientFactory.ts`

### New Auth Provider

1. Implement the `OAuthClientProvider` interface from `@modelcontextprotocol/client`
2. Add utilities to `src/auth/` module
3. Export documented helpers from `src/index.ts` (root); export low-level OAuth from `src/entries/auth.ts` (`./auth`)
