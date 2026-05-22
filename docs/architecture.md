# Architecture

This document describes the internal structure of `@gleanwork/mcp-server-tester` — its module layout, key data flows, and the design decisions that shaped them.

## Module Map

### `src/config/`

Defines and validates the `MCPConfig` discriminated union (`stdio` | `http`) using Zod. All transport configuration is typed and validated at the boundary via `validateMCPConfig()`. Nothing else in the codebase reaches into transport details directly; they go through this module first.

### `src/mcp/`

The MCP client layer. `clientFactory.ts` owns `createMCPClientForConfig()`, which translates an `MCPConfig` into a connected MCP SDK `Client` instance — choosing between `StdioClientTransport`, `StreamableHTTPClientTransport`, or `SSEClientTransport` based on config. `response.ts` normalises raw `CallToolResult` objects from the SDK into the framework's `NormalizedToolResponse` shape (with `.text`, `.isError`, `.contentBlocks`). The `fixtures/` subdirectory contains `MCPFixtureApi`, the high-level test helper wrapping the client.

### `src/fixtures/`

Playwright test fixtures. `mcp.ts` exposes `{ test, expect }` — `test` is the base Playwright `test` extended with `mcpClient` (raw SDK `Client`) and `mcp` (`MCPFixtureApi`). `expect` is the Playwright `expect` extended with all custom matchers. `mcpAuth.ts` provides an auth-specific fixture variant for OAuth and token auth flows. Configuration is read from `project.use.mcpConfig` in the consumer's `playwright.config.ts`.

### `src/assertions/`

The unified assertion layer. Internally split into:

- **`validators/`** — pure functions returning `ValidationResult` objects. They have no Playwright dependency and can be called from the eval runner, unit tests, or anywhere else.
- **`matchers/`** — thin Playwright adapter functions wrapping each validator. All matchers are registered in a single `expect.extend({})` call in `matchers/index.ts`, which re-exports the extended `expect`.

This separation is intentional: validators can be used programmatically without Playwright (e.g., in the eval runner), while matchers provide the idiomatic `expect(result).toContainToolText(...)` API in Playwright tests.

### `src/evals/`

The dataset-driven evaluation engine. Key files:

- `datasetTypes.ts` — Zod schemas for `EvalDataset`, `EvalCase`, and all expectation block types.
- `datasetLoader.ts` — reads and validates JSON datasets from disk.
- `evalRunner.ts` — `runEvalDataset()` iterates cases, calls the MCP server (or the LLM host simulator), validates results against each case's expectation block, and returns `EvalRunnerResult`. Supports multi-iteration accuracy tracking and configurable concurrency.
- `baseline.ts` — saves and loads pass/fail baselines for tracking regressions across runs.
- `resultStore.ts` — persists eval runs, reporter runs, and comparison artifacts to local files or GCS using a shared JSON envelope.
- `mcpHost/` — LLM host simulation (see data flow below).

### `src/judge/`

LLM-as-a-judge evaluation. `judgeTypes.ts` defines the `Judge` interface and `ProviderKind` union (`claude | anthropic | openai | google`). Each provider is a separate file (`claudeAgentJudge.ts`, `openaiJudge.ts`, `googleJudge.ts`). `judgeClient.ts` has the factory (`createJudgeClient()`) that dispatches to the right implementation. `rubrics.ts` provides built-in rubric definitions and the `resolveRubric()` helper.

### `src/auth/`

OAuth 2.1 with PKCE and static token utilities.

- `oauthFlow.ts` — low-level OAuth primitives: PKCE generation, authorization URL building, code exchange, token refresh. Uses `oauth4webapi`.
- `discovery.ts` — RFC 9728 protected resource discovery and OAuth authorization server metadata discovery.
- `oauthClientProvider.ts` — implements the MCP SDK's `OAuthClientProvider` interface, wiring together discovery, PKCE, and token storage for the SDK's automatic auth handling.
- `storage.ts` — file-based token persistence (`tokens.json`, `client.json`, `server.json`) with `0700`/`0600` permissions.
- `cli.ts` — `CLIOAuthClient`, which orchestrates the full browser-based OAuth login flow for the CLI and supports CI token injection from environment variables.
- `tokenAuth.ts` — static access token utilities (header generation, expiry checks).

### `src/spec/`

MCP protocol conformance checks. `conformanceChecks.ts` runs a set of server-level verifications (server info presence, tool schema validity) and returns a structured `ConformanceResult`. Used in tests to assert protocol compliance rather than specific tool behaviour.

### `src/reporters/`

Custom Playwright reporter. `mcpReporter.ts` is a Playwright `Reporter` implementation that collects eval case results attached to tests and writes them to a JSON/HTML output. The `ui-src/` subdirectory contains the React application that renders the report UI; it is compiled separately and embedded into `ui-dist/`. `build-ui.ts` is the build script for the React app.

### `src/cli/`

The `mcp-server-tester` CLI. `index.ts` is the entry point; the `commands/` directory contains one subdirectory per command (`init`, `generate`, `login`, `token`). `components/` holds Ink-based React components for the interactive prompts. `templates/` stores scaffold files emitted by `init`.

### `src/types/`

Canonical shared type definitions, kept here to prevent drift between modules:

- `index.ts` — core types: `AuthType`, `ResultSource`, `ExpectationType`, `EvalExpectationResult`.
- `reporter.ts` — reporter-specific types: `MCPEvalRunData`, `EvalCaseResult`, `MCPConformanceResultData`.

`src/reporters/ui-src/types.ts` re-exports all types directly from the canonical backend sources (`src/types/index.ts` and `src/types/reporter.ts`) — no manual sync is required.

---

## Data Flows

### Direct Eval Case (mode: "direct")

```
dataset JSON (on disk)
   ↓  datasetLoader.ts: loadEvalDataset()
EvalDataset (validated by Zod schema in datasetTypes.ts)
   ↓  evalRunner.ts: runEvalDataset()
per EvalCase:
   ↓  mcp.callTool(toolName, args)  ← MCPFixtureApi
   ↓  MCP SDK Client.callTool()
   ↓  Transport (stdio or HTTP)
   ↓  MCP Server (under test)
CallToolResult (raw SDK response)
   ↓  response.ts: normalizeToolResponse()
NormalizedToolResponse (.text, .isError, .contentBlocks)
   ↓  validators/: validateText(), validateSchema(), validatePattern(), etc.
ValidationResult (pass: boolean, message: string)
   ↓  evalRunner.ts: aggregated into EvalCaseResult
EvalRunnerResult (.passed, .failed, .caseResults, .durationMs)
   ↓  mcpReporter.ts: attached to Playwright TestInfo as JSON attachment
HTML report (ui-dist/)
```

### LLM Host Eval Case (mode: "mcp_host")

```
EvalCase { mode: "mcp_host", scenario, mcpHostConfig, expect.toolsTriggered }
   ↓  evalRunner.ts: detects mcp_host mode
   ↓  mcpHost/mcpHostSimulation.ts: simulateMCPHost()
   ↓  mcpHost/adapters/vercel.ts: createVercelOrchestrator()
      - Lists MCP tools via mcp.listTools()
      - Sends tools + scenario prompt to the configured LLM provider (via Vercel AI SDK)
      - LLM generates text and calls tools autonomously (multi-turn, up to maxSteps)
      - Each tool call is forwarded to the MCP server via mcp.callTool()
MCPHostSimulationResult (.toolCallsMade[], .success, .finalText)
   ↓  validators/: validateToolCalls(), validateToolCallCount()
ValidationResult
   ↓  evalRunner.ts: rolled into EvalCaseResult (with optional accuracy over N iterations)
EvalRunnerResult
```

### External Result Storage

```
EvalRunnerResult / MCPEvalRunData / comparison result
   ↓  resultStore.ts: createStoredEvalArtifact()
StoredEvalArtifact { schemaVersion, kind, id, metadata, data }
   ↓
FileEvalResultStore or GCSEvalResultStore
   ↓
eval-runs/, reporter-runs/, or comparisons/
   ↓
latest.json + immutable <id>.json
```

The eval runner uses stored `eval-runner-result` artifacts for baseline
regression detection. `compareEvalRuns()` remains pure; helpers load stored runs
and save comparison artifacts around it. The Playwright reporter stores
`reporter-run` artifacts for cross-run trend history while continuing to generate
local HTML reports.

### Auth Flow

```
CLI user runs: mcp-server-tester login <server-url>
   ↓
auth/cli.ts: CLIOAuthClient.login()
   ↓
auth/discovery.ts: discoverProtectedResource()   [RFC 9728: GET /.well-known/oauth-protected-resource]
   ↓
auth/discovery.ts: discoverAuthorizationServer()  [RFC 8414: GET /.well-known/oauth-authorization-server]
   ↓
auth/oauthFlow.ts: generatePKCE()                 [code_verifier + code_challenge]
auth/oauthFlow.ts: buildAuthorizationUrl()
   ↓
Browser opens → user authenticates → redirect to localhost callback
   ↓
auth/oauthFlow.ts: exchangeCodeForTokens()        [PKCE code_verifier cleared after exchange]
   ↓
auth/storage.ts: saveTokens()                     [written to ~/.local/state/mcp-tests/<key>/ with 0600 perms]
   ↓
At test time:
auth/oauthClientProvider.ts: PlaywrightOAuthClientProvider
   ↓  implements OAuthClientProvider (MCP SDK interface)
   ↓  getTokens() → reads from storage
   ↓  refreshToken() → auth/oauthFlow.ts: refreshAccessToken()
mcp/clientFactory.ts: createMCPClientForConfig(config, { authProvider })
   ↓  MCP SDK Client uses authProvider to inject Bearer token into transport headers
```

---

## Key Design Decisions

### Why Playwright for e2e / integration tests?

The framework is built to help users write Playwright tests for MCP servers. Using Playwright for its own integration tests (against the mock server) means the framework exercises the exact same fixture, config, and reporter surface that consumers use. It also means the CI pipeline runs the framework tests in the same environment as consumer CI pipelines.

### Why Vitest for unit tests?

Playwright's test runner is process-heavy and starts real browser workers. Unit tests for pure logic (validators, config parsing, OAuth utilities) don't need that overhead. Vitest's ESM-native, watch-friendly runner is a better fit, and it supports the same `expect` assertions. The two test runners co-exist: `npm test` runs Vitest, `npm run test:playwright` runs Playwright.

### Why two modes (direct vs. mcp_host)?

Direct mode tests are deterministic: you specify exact inputs and assert exact outputs. They are fast, cheap, and suitable for CI regression gates. LLM host mode tests are non-deterministic: they validate whether a real LLM can discover and invoke the right tools given only natural language and the tool's description. The two modes answer different questions — direct mode validates correctness, LLM host mode validates discoverability — and they need to be run and interpreted differently (direct: once per CI run; LLM host: N iterations, measure accuracy).

### Why a separate assertions/validators layer?

Early versions of the framework coupled assertions directly to Playwright matchers. When the eval runner was added (which needed to validate responses outside of Playwright's `expect()`), we had to duplicate logic. The split into pure `validators` (framework-agnostic) and `matchers` (Playwright adapters) eliminates the duplication: the eval runner calls validators directly, and the matchers are a thin wrapper providing the `expect(result).toContainToolText()` ergonomics for inline Playwright tests.
