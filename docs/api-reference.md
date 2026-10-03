# API Reference

Complete API documentation for `@gleanwork/mcp-server-tester`.

## Entry points

| Import from                                          | Contents                                                                                                                                                           | Stability                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `@gleanwork/mcp-server-tester`                       | Fixtures, matchers and validators, the MCP client, config, datasets with `runEvalDataset` and `runEvalCase`, judges, conformance, Agent Skills                     | Stable                                          |
| `@gleanwork/mcp-server-tester/fixtures/mcp`          | `test` and `expect` with the MCP fixtures and matchers                                                                                                             | Stable                                          |
| `@gleanwork/mcp-server-tester/fixtures/mcpAuth`      | Auth fixtures                                                                                                                                                      | Stable                                          |
| `@gleanwork/mcp-server-tester/reporters/mcpReporter` | The MCP reporter                                                                                                                                                   | Stable                                          |
| `@gleanwork/mcp-server-tester/evals`                 | The evaluation framework: manifests, suites and batches, extension definition types, metrics, result stores, comparisons, variant experiments, MCP host simulation | Stable                                          |
| `@gleanwork/mcp-server-tester/auth`                  | Low-level OAuth: discovery, token storage, client credentials                                                                                                      | Stable                                          |
| `@gleanwork/mcp-server-tester/experimental/hosts`    | Desktop and external hosts, Cowork settings and audit, host plugins                                                                                                | Experimental: may change between minor versions |
| `@gleanwork/mcp-server-tester/types`                 | The root's shared types on their own, without runtime code                                                                                                         | Stable                                          |

The `./evals`, `./auth` and `./experimental/hosts` subpaths are ESM only, and CommonJS code cannot `require` them. The ESM root and those three subpaths share one copy of the library, so anything registered through one is visible through the others. The CommonJS root is a separate copy; don't mix it with ESM imports of the subpaths. Optional desktop-host fields on root result types (such as `EvalCaseResult.externalHost`) are typed from `./experimental/hosts` and share its stability.

## Table of Contents

- [Entry points](#entry-points)
- [Fixtures](#fixtures)
- [Authentication](#authentication)
- [Eval Functions](#eval-functions)
- [Programmatic Validators](#programmatic-validators)
- [Playwright Matchers](#playwright-matchers)
- [Text Utilities](#text-utilities)
- [Judge Functions](#judge-functions)
- [Conformance Functions](#conformance-functions)
- [Protocol Helpers](#protocol-helpers)

## Fixtures

### `mcpPlugins` option

Plugins whose extensions this project's tests use, such as a judge referenced as `toPassToolJudge({ judge: 'acme/completeness' })`. Set it in a project's `use` block or with `test.use({ mcpPlugins: [acme] })`. The `mcp` and `mcpClient` fixtures install them. See [Plugins](evaluation-framework.md#plugins).

### `installPlugins(plugins)`

Install plugin objects for code that calls validators or matchers outside `runEvalDataset`, `runEvalCase`, a suite, or the `mcp` fixture (all of which install the plugins you pass them). Validates every plugin first; installing the same plugin again is a no-op, and a different plugin claiming a loaded namespace throws. Returns the validated plugins.

### `mcpClient: Client`

Raw MCP SDK client from `@modelcontextprotocol/client` (MCP TypeScript SDK v2).

```typescript
test('use raw client', async ({ mcpClient }) => {
  const tools = await mcpClient.listTools();
  const result = await mcpClient.callTool({ name: 'tool_name', arguments: { ... } });
});
```

### `mcp: MCPFixtureApi`

High-level test API with helper methods.

```typescript snippet=src/mcp/fixtures/mcpFixture.ts#L83-L138
/**
 * High-level API for interacting with MCP servers in tests
 *
 * This interface wraps the raw MCP Client with test-friendly methods
 */
export interface MCPFixtureApi extends MCPFixtureExtensions {
  /**
   * The underlying MCP client (for advanced usage)
   */
  client: Client;

  /**
   * Authentication type used for this test session
   */
  authType: AuthType;

  /**
   * Playwright project name for this test session
   */
  project?: string;

  /**
   * The protocol this connection requested and negotiated, e.g.
   * `{ requested: '2026-07-28', negotiated: '2026-07-28', era: 'modern' }`.
   * Use it to skip era-specific tests:
   * `test.skip(mcp.protocol.era !== 'modern')`.
   */
  readonly protocol: MCPProtocolInfo;

  /**
   * Lists all available tools from the MCP server
   *
   * @returns Array of tool definitions
   */
  listTools(): Promise<Array<Tool>>;

  /**
   * Calls a tool on the MCP server
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Tool call result
   */
  callTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: TArgs
  ): Promise<CallToolResult>;

  /**
   * Gets information about the connected server
   */
  getServerInfo(): {
    name?: string;
    version?: string;
  } | null;
}
```

#### Methods

##### `listTools()`

List all tools available from the MCP server.

**Returns:** `Promise<Array<Tool>>`

```typescript
const tools = await mcp.listTools();
console.log(tools.map((t) => t.name));
```

##### `callTool<TArgs>(name, args)`

Call a tool by name with arguments.

**Parameters:**

- `name: string` - Tool name
- `args: TArgs` - Tool arguments

**Returns:** `Promise<CallToolResult>`

```typescript
const result = await mcp.callTool('get_weather', { city: 'London' });
```

##### `getServerInfo()`

Get server information (name, version).

**Returns:** `{ name?: string; version?: string } | null`

```typescript
const info = mcp.getServerInfo();
console.log(info?.name, info?.version);
```

##### `protocol`

The protocol the connection requested and negotiated: `{ requested, negotiated, era }`, e.g. `{ requested: '2026-07-28', negotiated: '2026-07-28', era: 'modern' }`. See [Protocol Versions](./protocol-versions.md).

##### `discover()`

The `server/discover` result on 2026-07-28 connections, `null` on legacy connections.

**Returns:** `Promise<DiscoverResult | null>`

##### `listResources()` / `readResource(uri)`

`resources/list` (all pages) and `resources/read`.

**Returns:** `Promise<Resource[]>` / `Promise<ReadResourceResult>`

##### `request(method, params, resultSchema)`

Send any request, such as an extension method, and validate the result against a Standard Schema (for example a Zod schema).

```typescript
const result = await mcp.request(
  'skills/list',
  {},
  z.object({ skills: z.array(z.object({ uri: z.string() })) })
);
```

##### `skills`

Agent Skills (SEP-2640) helpers: `supported()`, `settings()`, `list()`, `get(uri)`, and `read(uri, { entry?, verify? })`, which verifies digest, size, and frontmatter against the skill's entry. See [Agent Skills](./skills.md).

```typescript
const [entry] = await mcp.skills.list();
const skill = await mcp.skills.read(entry!.uri);
expect(skill.verified).toBe(true);
```

### `createFixtureExtensions(client)`

Builds `discover`, `listResources`, `readResource`, `request`, and `skills` for a client. Use it (with `getProtocolInfo(client)` for `protocol`) when you implement `MCPFixtureApi` yourself.

### `createMCPFixture(client, testInfo?, options?)`

Creates an `MCPFixtureApi` wrapper around a raw MCP `Client`. Use this when you need manual fixture setup — for example in custom fixture hierarchies, non-Playwright test runners (Vitest, Jest), or when composing with other lifecycle logic.

For the standard Playwright use case, prefer importing `test` and `mcp` from `@gleanwork/mcp-server-tester/fixtures/mcp`, which wires this up automatically.

**Parameters:**

- `client: Client` — MCP client created via `createMCPClientForConfig()`. A client created another way works for calls, but `mcp.protocol` reports the default requested setting, and conformance probes and wire-level checks skip, because MST didn't record how it connected.
- `testInfo?: TestInfo` — Optional Playwright `TestInfo`. When provided, operations are wrapped in `test.step()` and attachments are created for the MCP reporter
- `options?: MCPFixtureOptions` — Optional configuration

**`MCPFixtureOptions`:**

| Field           | Type                               | Default  | Description                                                      |
| --------------- | ---------------------------------- | -------- | ---------------------------------------------------------------- |
| `authType`      | `'oauth' \| 'api-token' \| 'none'` | `'none'` | Authentication type for this session                             |
| `project`       | `string`                           | —        | Playwright project name (for filtering/grouping in the reporter) |
| `callTimeoutMs` | `number`                           | `30000`  | Timeout in milliseconds for MCP operations                       |

**Returns:** `MCPFixtureApi`

```typescript
import {
  createMCPFixture,
  createMCPClientForConfig,
  closeMCPClient,
} from '@gleanwork/mcp-server-tester';
import { test as base } from '@playwright/test';
import type { MCPFixtureApi } from '@gleanwork/mcp-server-tester';

const test = base.extend<{ mcp: MCPFixtureApi }>({
  mcp: async ({}, use, testInfo) => {
    const client = await createMCPClientForConfig(config);
    const api = createMCPFixture(client, testInfo, { authType: 'api-token' });
    await use(api);
    await closeMCPClient(client);
  },
});

// Non-Playwright usage (no reporter attachments)
const client = await createMCPClientForConfig(config);
const api = createMCPFixture(client);
const tools = await api.listTools();
```

## Authentication

For comprehensive authentication documentation, see the [Authentication Guide](./authentication.md).

### Token Utilities

```typescript
import {
  createTokenAuthHeaders,
  validateAccessToken,
  isTokenExpired,
  isTokenExpiringSoon,
} from '@gleanwork/mcp-server-tester';
```

#### `createTokenAuthHeaders(accessToken, tokenType?)`

Create HTTP headers with Authorization header.

**Parameters:**

- `accessToken: string` - Access token
- `tokenType?: string` - Token type (default: `'Bearer'`)

**Returns:** `Record<string, string>`

```typescript
const headers = createTokenAuthHeaders(process.env.MCP_ACCESS_TOKEN);
// { Authorization: 'Bearer eyJ...' }
```

#### `validateAccessToken(accessToken)`

Validate that an access token is present and non-empty.

**Parameters:**

- `accessToken: string | undefined` - Token to validate

**Throws:** `Error` if token is missing or empty

#### `isTokenExpired(accessToken)`

Check if a JWT token appears to be expired.

**Parameters:**

- `accessToken: string` - JWT token

**Returns:** `boolean`

#### `isTokenExpiringSoon(expiresAt, bufferMs?)`

Check if a token will expire within the buffer time.

**Parameters:**

- `expiresAt: number | undefined` - Expiration timestamp in milliseconds
- `bufferMs?: number` - Buffer time (default: `60000` = 1 minute)

**Returns:** `boolean`

### OAuth Client Provider

```typescript
import { PlaywrightOAuthClientProvider } from '@gleanwork/mcp-server-tester';
```

Implements the MCP SDK's `OAuthClientProvider` interface with file-based storage.

```typescript
const provider = new PlaywrightOAuthClientProvider({
  storagePath: 'playwright/.auth/mcp-oauth-state.json',
  redirectUri: 'http://localhost:3000/oauth/callback',
  clientId: process.env.MCP_OAUTH_CLIENT_ID,
  clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
});
```

### Auth Fixture

```typescript
import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';

test('uses auth provider', async ({ mcpAuthProvider }) => {
  // mcpAuthProvider is configured from environment variables
});
```

### Auth Configuration Types

```typescript
interface MCPAuthConfig {
  accessToken?: string;
  oauth?: MCPOAuthConfig;
}

interface MCPOAuthConfig {
  serverUrl: string;
  scopes?: string[];
  resource?: string;
  authStatePath?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}
```

## Eval Functions

### `loadEvalDataset(path, options?)`

Load an eval dataset from a JSON file.

**Parameters:**

- `path: string` - Path to dataset JSON file
- `options?: object`
  - `schemas?: Record<string, ZodSchema>` - Zod schemas for validation

**Returns:** `Promise<EvalDataset>`

```typescript
const dataset = await loadEvalDataset('./data/evals.json', {
  schemas: {
    'weather-response': z.object({
      city: z.string(),
      temperature: z.number(),
    }),
  },
});
```

### `runEvalDataset(options, context)`

Run an eval dataset. Expectations are defined per-case in the dataset's `expect` blocks.

**Parameters:**

- `options: EvalRunnerOptions`
  - `dataset: EvalDataset` - Dataset to run
  - `plugins?: readonly Plugin[]` - Plugins whose extensions (for example `acme/completeness` judges) the cases use
  - `schemas?: Record<string, ZodType>` - Schema registry for `expect.schema` validation by name
  - `stopOnFailure?: boolean` - Stop on first failure (default: `false`)
  - `onCaseComplete?: (result: EvalCaseResult) => void` - Callback after each case completes
  - `concurrency?: number` - Max parallel cases (default: `1` = sequential)
  - `defaultLlmIterations?: number` - Default iteration count for `mcp_host` cases (default: `1`)
  - `defaultJudgeReps?: number` - Default judge evaluation count per case (default: `1`)
  - `filterTags?: string[]` - Only run cases whose `tags` contain at least one match
  - `saveResultsTo?: string` - Save run results to file for baseline comparison
  - `omitResponsesFromBaseline?: boolean` - Strip responses from saved baseline (default: `true`)
  - `baselineResultsFrom?: string` - Load baseline file for regression detection
  - `toolOverrides?: ToolOverrideVariant` - Runtime tool metadata overrides for variant experiments
  - `mcpHostModel?: string` - Model identifier recorded in run metadata
  - `judgeModel?: string` - Judge model identifier recorded in run metadata
- `context: EvalContext`
  - `mcp: MCPFixtureApi` - MCP fixture API
  - `testInfo?: TestInfo` - Playwright test info (required for snapshot support)
  - `expect?: ExpectType` - Playwright expect function (required for snapshot support)

**Returns:** `Promise<EvalRunnerResult>`

```typescript
const result = await runEvalDataset(
  { dataset }, // options — what to run and how
  { mcp, testInfo } // context — Playwright fixtures from your test
);

console.log(`Passed: ${result.passed}/${result.total}`);
```

Runtime tool overrides let you test alternate tool descriptions or input schemas without editing the eval dataset or MCP server source. Tool names are canonical server tool names; v1 does not support renames.

```typescript
const variant = {
  id: 'search-description-v2',
  tools: {
    search: {
      description:
        'Search internal company documents, policies, wiki pages, and announcements.',
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

console.log(candidate.metadata?.toolOverrideVariantId);
```

Use `compareEvalRuns()` to summarize the completed baseline and candidate runs:

```typescript
import { compareEvalRuns } from '@gleanwork/mcp-server-tester/evals';

const comparison = compareEvalRuns({
  baseline,
  candidate,
  labels: {
    baseline: 'baseline',
    candidate: variant.id,
  },
});

console.log(`Pass-rate delta: ${comparison.deltaPassRate}`);
console.log(`Improved cases: ${comparison.improvedCases.length}`);
console.log(`Regressed cases: ${comparison.regressedCases.length}`);
```

```typescript
interface ToolOverrideVariant {
  id: string;
  description?: string;
  tools: Record<
    string,
    {
      description?: string;
      inputSchema?: Record<string, unknown>;
    }
  >;
}
```

### `compareEvalRuns(options)`

Compare two completed eval runs. This is a pure utility: it does not run evals, read or write baselines, call LLMs, or mutate datasets.

**Parameters:**

- `options: CompareEvalRunsOptions`
  - `baseline: EvalRunnerResult` - Baseline run result
  - `candidate: EvalRunnerResult` - Candidate run result
  - `labels?: { baseline?: string; candidate?: string }` - Optional display labels

**Returns:** `EvalRunComparisonResult`

```typescript
const comparison = compareEvalRuns({
  baseline,
  candidate,
});
```

The result includes pass-rate deltas, optional tool precision/recall/F1 deltas, and case buckets:

- `improvedCases` - failed in baseline, passed in candidate
- `regressedCases` - passed in baseline, failed in candidate
- `unchangedPasses` - passed in both runs
- `unchangedFailures` - failed in both runs
- `missingFromBaseline` - case exists only in candidate
- `missingFromCandidate` - case exists only in baseline

It also has `warnings: string[]`, which flags runs that negotiated different MCP protocol eras or revisions (from `metadata.protocol`).

### `runSkillsComparison(options, context)`

Run a dataset once per `mcpHostConfig.skills` mode and compare each mode against the first. Only `mcp_host` cases change between variants.

**Parameters:**

- `options: SkillsComparisonOptions` - `EvalRunnerOptions` plus `variants?: ('off' | 'catalog' | 'preload')[]` (default `['off', 'catalog']`)
- `context: EvalContext`

**Returns:** `Promise<SkillsComparisonResult>` with `variants[]` (`mode`, `result`, `summary: { passRate, skillLoadRate?, skillBeforeToolRate?, skillVerificationFailureRate? }`) and `comparisons[]` (`EvalRunComparisonResult` per candidate mode).

```typescript
const result = await runSkillsComparison(
  { dataset, variants: ['off', 'catalog', 'preload'] },
  { mcp, testInfo }
);
```

See [Agent Skills](./skills.md#measuring-whether-skills-help).

### External Result Storage

External result storage persists eval runs, reporter runs, and comparison artifacts
as JSON. GCS is the first built-in cloud provider.

```typescript
type StoredArtifactKind =
  | 'eval-runner-result'
  | 'reporter-run'
  | 'eval-run-comparison'
  | 'server-comparison';

interface EvalResultStore {
  saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void>;
  loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>>;
  loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null>;
  listArtifacts(
    kind: StoredArtifactKind,
    options?: { limit?: number }
  ): Promise<StoredArtifactSummary[]>;
}
```

Create a store from config:

```typescript
import { createEvalResultStore } from '@gleanwork/mcp-server-tester/evals';

const store = createEvalResultStore({
  provider: 'gcs',
  bucket: 'my-mcp-eval-results',
  prefix: 'my-server/main',
});
```

`runEvalDataset()` accepts store-backed baseline references in addition to local
file paths:

```typescript
await runEvalDataset(
  {
    dataset,
    resultStore: store,
    baselineResultsFrom: { store: true, ref: 'latest' },
    saveResultsTo: { store: true, ref: { id: 'candidate-run' } },
  },
  { mcp, testInfo }
);
```

Stored runs can be used with `compareEvalRuns()`:

```typescript
import {
  compareEvalRuns,
  loadStoredEvalRunnerResult,
  saveEvalRunComparison,
} from '@gleanwork/mcp-server-tester/evals';

const baseline = await loadStoredEvalRunnerResult(store, { id: 'baseline' });
const candidate = await loadStoredEvalRunnerResult(store, { id: 'candidate' });
const comparison = compareEvalRuns({
  baseline: baseline.data,
  candidate: candidate.data,
});

await saveEvalRunComparison({ store, comparison, id: 'candidate-comparison' });
```

**Result Structure:**

```typescript snippet=src/evals/evalRunner.ts#L125-L202
/**
 * Overall result of running an eval dataset
 */
export interface EvalRunnerResult {
  /**
   * Total number of cases
   */
  total: number;

  /**
   * Number of passing cases
   */
  passed: number;

  /**
   * Number of failing cases
   */
  failed: number;

  /**
   * Individual case results
   */
  caseResults: Array<EvalCaseResult>;

  /**
   * Overall execution time in milliseconds
   */
  durationMs: number;

  /**
   * Difference between current pass rate and baseline pass rate.
   * Positive = improvement, negative = regression.
   * Only present when `baselineResultsFrom` was provided.
   */
  deltaPassRate?: number;

  /**
   * Number of cases that regressed: passed in baseline, failed now.
   * Only present when `baselineResultsFrom` was provided.
   */
  regressions?: number;

  /**
   * Number of cases that improved: failed in baseline, passed now.
   * Only present when `baselineResultsFrom` was provided.
   */
  improvements?: number;

  /**
   * Average tool precision across all mcp_host cases that have a
   * `toolsTriggered` expectation (precision = fraction of called tools
   * that were expected). Only present when at least one such case ran.
   */
  datasetToolPrecision?: number;

  /**
   * Average tool recall across all mcp_host cases that have a
   * `toolsTriggered` expectation (recall = fraction of required tools
   * that were actually called). Only present when at least one such case ran.
   */
  datasetToolRecall?: number;

  /**
   * Harmonic mean of `datasetToolPrecision` and `datasetToolRecall`.
   * Only present when at least one case contributes precision/recall data.
   */
  datasetToolF1?: number;

  /**
   * Experiment tracking metadata captured at run time.
   */
  metadata?: EvalRunMetadata;

  /**
   * Aggregate token usage from all mcp_host LLM simulations across all cases.
   */
  totalHostUsage?: UsageMetrics;
```

### `runVariantExperiment(options, context)`

Run a tool-metadata variant experiment: establish a baseline, inject each candidate variant via `toolOverrides`, compare against the baseline, rank by a metric, guard against regressions, and emit a structured improvement proposal. This is the high-level API that wraps the manual baseline → candidate → `compareEvalRuns` loop.

**Parameters:**

- `options: VariantExperimentOptions`
  - `dataset: EvalDataset` - The dataset to run (never mutated)
  - `variants?: ToolOverrideVariant[]` - Static candidates tried in round 0
  - `proposeVariants?: (ctx: ProposeVariantsContext) => Promise<ToolOverrideVariant[]>` - Callback returning the next candidates from prior-round evidence; return `[]` to stop
  - `metric?: 'passRate' | 'toolF1' | 'toolPrecision' | 'toolRecall'` - Ranking metric (default `'passRate'`)
  - `maxRounds?: number` - Round budget (default `1`)
  - `minImprovement?: number` - Stop when a round's best gain is below this (default `0`)
  - `allowRegressions?: boolean` - Allow winners that regress cases (default `false`)
  - Plus `runEvalDataset` passthrough: `defaultLlmIterations`, `defaultJudgeReps`, `concurrency`, `filterTags`, `schemas`, `mcpHostModel`, `judgeModel`
- `context: EvalContext` - `{ mcp, testInfo? }` from your test

**Returns:** `VariantExperimentResult`

- `baseline` - The original no-override run
- `rounds` - Every round's candidates with per-candidate `result`, `comparison`, `metricValue`, `metricDelta`, `disqualified`
- `winner` - Best non-disqualified candidate across all rounds
- `proposal` - `VariantImprovementProposal` with `recommendation: 'apply' | 'reject' | 'inconclusive'`, metric values, `toolChanges`, and improved/regressed case ids
- `reason` - Why the experiment stopped: `'no-variants' | 'no-improvement' | 'max-rounds' | 'threshold-met'`

```typescript
import { runVariantExperiment } from '@gleanwork/mcp-server-tester/evals';

const result = await runVariantExperiment(
  {
    dataset,
    variants: [variant],
    metric: 'passRate',
    defaultLlmIterations: 10,
  },
  { mcp, testInfo }
);

if (result.proposal?.recommendation === 'apply') {
  console.log(result.winner?.variant.id, result.proposal.delta);
}
```

A candidate that regresses any case is disqualified from winning unless `allowRegressions: true`; the best attempt is still surfaced in `proposal` with `recommendation: 'reject'` so an agent can see what broke. See [MCP Host Simulation](./mcp-host.md#driving-it-from-an-agent-runvariantexperiment) for the full agent-loop example.

### `runEvalCase(evalCase, context, options?)`

Run a single eval case. Useful when you want fine-grained control over individual cases outside of a dataset, or when building custom eval orchestration.

**Parameters:**

- `evalCase: EvalCase` - The eval case to run
- `context: EvalContext`
  - `mcp: MCPFixtureApi` - MCP fixture API
  - `testInfo?: TestInfo` - Playwright test info (for reporter integration)
  - `expect?: Expect` - Playwright expect (for snapshot support)
- `options?: EvalCaseOptions`
  - `plugins?: readonly Plugin[]` - Plugins whose extensions the case uses
  - `datasetName?: string` - Dataset name for the result (default: `'single-case'`)
  - `schemas?: Record<string, ZodType>` - Schema registry for named schema validation

**Returns:** `Promise<EvalCaseResult>`

```typescript
import { runEvalCase } from '@gleanwork/mcp-server-tester';

test('single eval case', async ({ mcp }, testInfo) => {
  const result = await runEvalCase(
    {
      id: 'search-check',
      mode: 'direct',
      toolName: 'search',
      args: { query: 'planning' },
      expect: { textContains: ['result'] },
    },
    { mcp, testInfo }
  );

  expect(result.pass).toBe(true);
});
```

When `evalCase.iterations > 1`, the case is run multiple times and `result.assertionPassRate` is populated with the fraction of passing iterations.

---

## Programmatic Validators

Pure validation functions that power both Playwright matchers and the eval runner. Each returns a `ValidationResult` with `pass`, `message`, and optional `details`. Use these when you need validation logic outside of Playwright's `expect()` — for example in Vitest/Jest tests, eval datasets, or custom pipelines.

```typescript
import { validateText, validateSchema } from '@gleanwork/mcp-server-tester';

interface ValidationResult {
  pass: boolean;
  message: string;
  details?: Record<string, unknown>;
  metrics?: { precision?: number; recall?: number };
}
```

### `validateText(response, expected, options?)`

Checks that the response contains all expected text substrings.

**Parameters:**

- `response: unknown` — The response to validate
- `expected: string | string[]` — Substring(s) to find
- `options?: TextValidatorOptions` — `{ caseSensitive?: boolean }` (default: `true`)

```typescript
const result = validateText(response, ['temperature', 'conditions']);
const result2 = validateText(response, 'hello', { caseSensitive: false });
```

### `validatePattern(response, patterns, options?)`

Checks that the response matches all expected regex patterns.
Each pattern check starts at index zero and leaves the supplied `RegExp` object's
`lastIndex` unchanged. You can safely reuse global and sticky patterns.

**Parameters:**

- `response: unknown` — The response to validate
- `patterns: string | RegExp | (string | RegExp)[]` — Pattern(s) to match
- `options?: PatternValidatorOptions` — `{ caseSensitive?: boolean }` (default: `true`)

```typescript
const result = validatePattern(response, /temperature: \d+/);
const result2 = validatePattern(response, ['\\d+ degrees', /humidity: \d+%/]);
```

### `validateError(response, expected?)`

Checks that the response is (or is not) an error, optionally with a specific message.

**Parameters:**

- `response: unknown` — The response to validate
- `expected?: boolean | string | string[]` — `true` = expect any error, `false` = expect no error, `string` = expect error containing text (default: `true`)

```typescript
const result = validateError(response, true); // any error
const result2 = validateError(response, false); // no error
const result3 = validateError(response, 'not found'); // error with message
```

### `validateSize(response, options)`

Checks that the response size in bytes is within bounds.

**Parameters:**

- `response: unknown` — The response to validate
- `options: SizeValidatorOptions` — `{ minBytes?: number; maxBytes?: number }` (at least one required)

```typescript
const result = validateSize(response, { maxBytes: 10_000 });
const result2 = validateSize(response, { minBytes: 100, maxBytes: 50_000 });
```

### `validateSchema(response, schema, options?)`

Validates the response against a Zod schema. Automatically parses JSON text responses.

**Parameters:**

- `response: unknown` — The response to validate
- `schema: ZodType` — Zod schema to validate against
- `options?: SchemaValidatorOptions` — `{ strict?: boolean }` (default: `false`)

```typescript
import { z } from 'zod';

const WeatherSchema = z.object({
  temperature: z.number(),
  conditions: z.string(),
});

const result = validateSchema(response, WeatherSchema);
```

### `validateResponse(actual, expected)`

Deep equality comparison using JSON serialization.

**Parameters:**

- `actual: unknown` — The actual response
- `expected: unknown` — The expected response

```typescript
const result = validateResponse(response, { status: 'ok', count: 42 });
```

### `validateToolCalls(response, expectation)`

Validates tool calls from an MCP host simulation result. Only applicable to `mcp_host` mode.

**Parameters:**

- `response: unknown` — Must be an `MCPHostSimulationResult`
- `expectation: ToolCallExpectation` — Expected tool call specification

```typescript
import type { ToolCallExpectation } from '@gleanwork/mcp-server-tester';

const expectation: ToolCallExpectation = {
  calls: [{ name: 'search', required: true }],
  order: 'any',
  exclusive: false,
};

const result = validateToolCalls(simulationResult, expectation);
// result.metrics contains { precision, recall }
```

### `validateToolCallCount(response, options)`

Validates the number of tool calls from an MCP host simulation result. Only applicable to `mcp_host` mode.

**Parameters:**

- `response: unknown` — Must be an `MCPHostSimulationResult`
- `options: ToolCallCountOptions` — `{ min?: number; max?: number; exact?: number }`

```typescript
const result = validateToolCallCount(simulationResult, { min: 1, max: 3 });
```

### `validateJudge(response, config, run?)` (async)

Evaluates a response with a judge: the built-in `rubric` LLM judge or a plugin judge. Returns a `Promise<ValidationResult>`. A judge that can't score the response (an unknown judge, invalid options, an API error, a score outside 0 to 1) fails with `details.error` set. A judge that skips passes with `details.skipped` set.

**Parameters:**

- `response: unknown` — The response to evaluate
- `config: JudgeValidatorConfig` — Judge configuration
- `run?: JudgeRun` — `{ evalCase?, hostResponse?, evidence? }`, from which the judge's `{ case, trial }` input is built (see [Judge contract](./evaluation-framework.md#judge-contract)). Without it, the case is empty except for `expected.answer` (the `reference`).

**`JudgeValidatorConfig`:**

| Field       | Type                      | Default       | Description                                                                   |
| ----------- | ------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `judge`     | `string`                  | `'rubric'`    | The built-in `rubric`, or a plugin judge as `namespace/name`                  |
| `rubric`    | `RubricSpec`              | —             | Shorthand for the `rubric` judge (required unless `judge` is set)             |
| `reference` | `unknown`                 | —             | Reference response to compare against                                         |
| `threshold` | `number`                  | `0.7`         | Minimum mean score to pass (0–1)                                              |
| `reps`      | `number`                  | `1`           | Times the judge scores the response, for every judge (scores averaged)        |
| `options`   | `Record<string, unknown>` | —             | The judge's own options; without it, a named judge gets its other flat fields |
| `provider`  | `ProviderKind`            | `'anthropic'` | The `rubric` judge's LLM provider (also `model`, `temperature`, and so on)    |

```typescript
const result = await validateJudge(response, {
  rubric: 'Does the response accurately describe the weather?',
  threshold: 0.8,
});
```

### `validateSnapshot(response, name, options)` (async)

Compares a response's text, after sanitizing, with a named snapshot in a `SnapshotStore`. `toMatchToolSnapshot` and eval `snapshot` expectations both use it. Throws when a sanitizer is invalid, which is a configuration error, not a mismatch.

**Parameters:**

- `response: unknown` — The response to compare
- `name: string` — Snapshot name
- `options.store: SnapshotStore` — Where snapshots live: `playwrightSnapshotStore(expect)` inside a Playwright test, or your own `{ match(name, content, { negated }) }` that resolves to `{ pass, message }`
- `options.sanitizers?: SnapshotSanitizer[]` — Applied before comparison (see `toMatchToolSnapshot`)
- `options.negated?: boolean` — Compare for a `.not` assertion: `pass` is still "matches", but the store must not write snapshots, and a missing snapshot counts as a match. `playwrightSnapshotStore` uses Playwright's own `.not.toMatchSnapshot`.

```typescript
import {
  validateSnapshot,
  playwrightSnapshotStore,
} from '@gleanwork/mcp-server-tester';

const result = await validateSnapshot(response, 'weather', {
  store: playwrightSnapshotStore(expect),
  sanitizers: ['uuid', 'iso-date'],
});
```

### `validatePredicate(response, predicate, description?)` (async)

Runs a custom predicate, which receives the response and its extracted text. `description` names the predicate in default messages (default `'custom predicate'`). A predicate that throws fails with `details.error` set, so you can tell a crash from a `false`.

```typescript
const result = await validatePredicate(
  response,
  (_raw, text) => text.includes('temperature'),
  'mentions temperature'
);
```

## Playwright Matchers

Custom Playwright matchers for writing inline assertions against MCP tool responses. Import `expect` from the package or its fixtures:

```typescript
import { expect } from '@gleanwork/mcp-server-tester';
// or, when using fixtures:
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
```

### `toMatchToolResponse(expected)`

Assert that the tool response exactly deep-equals the expected value.

```typescript
test('exact response', async ({ mcp }) => {
  const result = await mcp.callTool('calculate', { a: 2, b: 3 });
  expect(result).toMatchToolResponse({ result: 5 });
});
```

For eval datasets, use the `expect.response` field:

```json
{
  "id": "calc-test",
  "toolName": "calculate",
  "args": { "a": 2, "b": 3 },
  "expect": {
    "response": { "result": 5 }
  }
}
```

### `toContainToolText(text | text[])`

Assert that the tool response text contains the given substring(s).

```typescript
test('text contains', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toContainToolText('temperature');
  expect(result).toContainToolText(['London', 'temperature', 'humidity']);
});
```

### `toMatchToolPattern(pattern | pattern[])`

Assert that the tool response text matches the given regex pattern(s).

```typescript
test('pattern match', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toMatchToolPattern('Temperature: \\d+°[CF]');
  expect(result).toMatchToolPattern(['^## Weather', '\\d{4}-\\d{2}-\\d{2}']);
});
```

### `toMatchToolSchema(schema)`

Assert that the tool response validates against a Zod schema.

```typescript
import { z } from 'zod';

const WeatherSchema = z.object({
  city: z.string(),
  temperature: z.number(),
  conditions: z.string(),
});

test('schema validation', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toMatchToolSchema(WeatherSchema);
});
```

### `toMatchToolSnapshot(name, sanitizers?)`

Assert that the tool response matches a saved Playwright snapshot. Use sanitizers to normalize variable fields (timestamps, UUIDs, etc.) before comparison.

```typescript
test('snapshot', async ({ mcp }, testInfo) => {
  const result = await mcp.callTool('help', {});
  expect(result).toMatchToolSnapshot('help-output');
});

// With sanitizers
expect(result).toMatchToolSnapshot('user-profile', ['uuid', 'iso-date']);
```

### `toBeToolError(expected?)`

Assert that the tool response is an error (or is not an error when negated). Optionally assert on the error message.

```typescript
test('error handling', async ({ mcp }) => {
  const result = await mcp.callTool('nonexistent_tool', {});
  expect(result).toBeToolError();

  // Assert specific error message substring
  expect(result).toBeToolError('not found');

  // Assert response is NOT an error
  const good = await mcp.callTool('get_weather', { city: 'London' });
  expect(good).not.toBeToolError();
});
```

### `toPassToolJudge(rubric, options?)`

Assert that the tool response passes a judge: the built-in `rubric` judge (an LLM call) or, with `{ judge: 'namespace/name' }`, a plugin judge. The matcher takes `passingThreshold` (default `0.7`), `reference`, `reps`, `provider`, `model`, `judge` and `options`.

```typescript
test('semantic quality', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'authentication' });
  await expect(result).toPassToolJudge(
    {
      text: 'The results should be relevant to the query about authentication. Score 0-1.',
    },
    { passingThreshold: 0.7 }
  );
});
```

### `toHaveToolResponseSize(options)`

Assert that the tool response size is within specified byte bounds.

```typescript
test('response size', async ({ mcp }) => {
  const result = await mcp.callTool('list_files', {});
  expect(result).toHaveToolResponseSize({ minBytes: 10, maxBytes: 50000 });
});
```

### `toSatisfyToolPredicate(fn, desc?)`

Assert that the tool response satisfies a custom predicate function.

```typescript
test('custom predicate', async ({ mcp }) => {
  const result = await mcp.callTool('list_files', {});
  expect(result).toSatisfyToolPredicate(
    (r) => Array.isArray(r.content) && r.content.length > 0,
    'response should contain at least one file'
  );
});
```

### `toHaveToolCalls(expectation)` (mcp_host mode only)

Assert that the LLM made specific tool calls when given a natural language prompt. Only meaningful in `mcp_host` mode.

```typescript
test('tool discovery', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'find recent docs' });
  expect(result).toHaveToolCalls({
    calls: [{ name: 'search', required: true }],
    order: 'any',
    exclusive: false,
  });
});
```

### `toHaveToolCallCount(options)` (mcp_host mode only)

Assert that the LLM made a specific number of tool calls. Only meaningful in `mcp_host` mode.

```typescript
test('call count', async ({ mcp }) => {
  const result = await mcp.callTool('search', { query: 'find docs' });
  expect(result).toHaveToolCallCount({ min: 1, max: 5 });
});
```

## Text Utilities

### `extractText(response)`

Extract text content from various MCP response formats.

**Parameters:**

- `response: CallToolResult` - MCP tool call result

**Returns:** `string`

```typescript
const result = await mcp.callTool('get_info', {});
const text = extractText(result);
```

### `normalizeWhitespace(text)`

Normalize whitespace for consistent comparison.

**Parameters:**

- `text: string` - Text to normalize

**Returns:** `string`

```typescript
const normalized = normalizeWhitespace('  hello\n\n  world  ');
// Returns: "hello world"
```

## Judge Functions

### `createJudge(config?)`

Create an LLM judge for semantic evaluation of tool responses.

**Parameters:**

- `config?: JudgeConfig` (all fields optional)
  - `provider?: 'anthropic' | 'openai' | 'google'` - LLM provider (default: `'anthropic'`)
  - `model?: string` - Model name (default: `'claude-sonnet-4-20250514'`)
  - `temperature?: number` - Temperature 0–1 (default: `0.0`)
  - `maxTokens?: number` - Maximum tokens for response (default: `1000`)
  - `maxBudgetUsd?: number` - Maximum budget in USD (default: `0.10`)
  - `maxToolOutputSize?: number` - Fail if response exceeds this byte count

**Returns:** `Judge`

**Default (Claude):**

```typescript
import { createJudge } from '@gleanwork/mcp-server-tester';

const judge = createJudge();
// Requires: ANTHROPIC_API_KEY environment variable, or a gateway credential
// (see LLM Gateways: ./llm-gateways.md)
```

**With configuration:**

```typescript
const judge = createJudge({
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.0,
});
// Requires: OPENAI_API_KEY environment variable, or a gateway credential
```

### LLM Host Diagnostic Utilities

The following utilities are available for checking whether optional LLM provider packages are installed. They are useful for debugging provider configuration issues but are not part of the typical test-writing path.

#### `isProviderAvailable(provider)`

Check whether the npm package required for a given `mcp_host` provider is installed in the current environment.

```typescript
import { isProviderAvailable } from '@gleanwork/mcp-server-tester/evals';

if (!isProviderAvailable('anthropic')) {
  console.warn('Install @anthropic-ai/sdk to use the anthropic provider');
}
```

#### `getMissingDependencyMessage(provider)`

Return a human-readable message describing the missing dependency for a provider, suitable for displaying in error output or test skip conditions.

```typescript
import { getMissingDependencyMessage } from '@gleanwork/mcp-server-tester/evals';

const message = getMissingDependencyMessage('openai');
// e.g. "Provider 'openai' requires the 'openai' package. Run: npm install openai"
```

See [LLM Host Guide](./mcp-host.md) for full details on configuring `mcp_host` mode.

## Conformance Functions

### `runConformanceChecks(mcp, options?)`

Run MCP protocol conformance checks.

**Parameters:**

- `mcp: MCPFixtureApi` - MCP fixture API
- `options?: object`
  - `requiredTools?: string[]` - Tools that must be present
  - `validateSchemas?: boolean` - Validate tool input schemas (default: `true`)
  - `checkServerInfo?`, `checkResources?`, `checkPrompts?: boolean` - Toggle those checks (default: `true`)
  - `probe?: boolean` - Allow raw probe requests for 2026-07-28 rejection rules (default: `true`)
  - `skills?: { maxSkills?: number; verifyFiles?: 'skill-md' | 'all'; maxPages?: number } | false` - Tune or disable the skills checks (defaults: 25 skills, `'skill-md'`, 64 pages)
- `testInfo?: TestInfo` - Attach results to the MCP reporter

Checks are selected by the negotiated era: legacy connections run the core checks; 2026-07-28 connections also run the [modern checks](./protocol-versions.md#conformance-by-era); servers that declare the skills extension get the [skills checks](./skills.md#conformance) in every era.

**Returns:** `Promise<MCPConformanceResult>`

```typescript
const result = await runConformanceChecks(mcp, {
  requiredTools: ['get_weather', 'search_docs'],
  validateSchemas: true,
});

expect(result.pass).toBe(true);
```

**Result Structure:**

```typescript
interface MCPConformanceResult {
  pass: boolean; // every non-skipped 'must' check passed
  checks: Array<{
    name: string;
    pass: boolean;
    message: string;
    severity?: 'must' | 'should'; // failing 'should' checks are warnings
    skipped?: boolean; // not applicable here; message says why
    specVersion?: string; // e.g. '2026-07-28'
    specRef?: string; // spec section the check enforces
  }>;
  protocol: MCPProtocolInfo; // { requested, negotiated, era }
  raw: MCPConformanceRaw; // serverInfo, capabilities, tools, resources, prompts
}
```

### `runCrossEraChecks(config, options?, testInfo?)`

Connect to the same server once per protocol and check it serves the same tools, tool definitions, resources, prompts, skills, and capabilities in each, and that `protocol: 'auto'` picks the modern era.

**Parameters:**

- `config: MCPConfig`
- `options?: { protocols?: ProtocolSetting[]; checkAuto?: boolean; clientOptions?: Omit<CreateMCPClientOptions, 'protocol'> }` - `protocols` defaults to `['legacy', '2026-07-28']`
- `testInfo?: TestInfo`

**Returns:** `Promise<MCPCrossEraResult>` with `pass`, `checks`, and `connections`.

## Protocol Helpers

### `protocolMatrix(project, protocols)`

Expand one Playwright project into one project per protocol, named `<name>@<protocol>`, with `mcpProtocol` and `mcpConfig.protocol` set.

```typescript
projects: [
  ...protocolMatrix({ name: 'docs', use: { mcpConfig } }, [
    'legacy',
    '2026-07-28',
  ]),
];
```

### `getProtocolInfo(client)`

`{ requested, negotiated, era }` for a client created by MST.

### `eraOfRevision(revision)` / `isProtocolRevision(value)`

Classify a dated revision as `'legacy'` or `'modern'`, and check a string is a `YYYY-MM-DD` revision.

### `DEFAULT_PROTOCOL_SETTING` / `ProtocolMatrixEntry<T>`

`DEFAULT_PROTOCOL_SETTING` is `'legacy'`, the `protocol` used when none is set. `ProtocolMatrixEntry<T>` is the type of each project `protocolMatrix()` returns.

## Tool Call Helpers

### `callToolNormalized(client, params, options?)`

What `mcp.callTool()` uses: calls a tool on a raw SDK `Client` and turns a JSON-RPC error sent by the server (such as `-32602` for an unknown tool) into an `isError: true` result whose text is `MCP error <code>: <message>`. Local SDK errors (timeouts, closed connections, auth) still reject.

### `getToolProtocolError(result)`

The `{ code, message, data? }` of the protocol error a result was made from, or `null` for results the server returned.

## Skills Functions

`mcp.skills` wraps these; use them directly with a raw SDK `Client`. See [Agent Skills](./skills.md).

| Export                              | Purpose                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `getSkillsExtension(client)`        | The server's `io.modelcontextprotocol/skills` settings, or `null` when it doesn't declare the extension |
| `listSkills(client, { maxPages? })` | All `skills/list` entries, following `nextCursor` (default 64 pages)                                    |
| `getSkill(client, uri)`             | One entry from `skills/get`                                                                             |
| `readSkillFile(client, uri)`        | Read a skill file with `resources/read`: `{ uri, text?, bytes, mimeType? }`                             |
| `verifySkillFile(entry, file)`      | Problems (digest, size, `SKILL.md` frontmatter) found checking a read file against its entry            |
| `validateSkillEntry(entry)`         | SEP-2640 entry problems, each with `severity: 'must' \| 'should'`                                       |
| `parseSkillFrontmatter(markdown)`   | The YAML frontmatter of a `SKILL.md` as an object, or `null` without one                                |
| `SkillEntrySchema`                  | Zod schema for the wire shape of an entry (use `validateSkillEntry()` for the SEP rules)                |

## Type Definitions

### `EvalExpectBlock`

```typescript snippet=src/evals/datasetTypes.ts#L216-L317
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature for judge LLM (0–1) */
  temperature?: number;
  /** Max budget in USD per evaluation */
  maxBudgetUsd?: number;
  /** Fail if response exceeds this size in bytes before judging */
  maxToolOutputSize?: number;
}

/**
 * Unified expectation block for eval cases
 *
 * Mirrors the Playwright matcher API for consistency.
 */
export interface EvalExpectBlock {
  /**
   * Exact response match (toMatchToolResponse)
   */
  response?: unknown;

  /**
   * Name of schema to validate against (toMatchToolSchema)
   */
  schema?: string;

  /**
   * Text substring(s) that must be present (toContainToolText)
   */
  containsText?: string | string[];

  /**
   * Regex pattern(s) that must match (toMatchToolPattern)
   */
  matchesPattern?: string | string[];

  /**
   * Snapshot name for comparison (toMatchToolSnapshot)
   */
  snapshot?: string;

  /**
   * Snapshot sanitizers to apply
   */
  snapshotSanitizers?: SnapshotSanitizer[];

  /**
   * Error expectation (toBeToolError)
   * - true: expects any error
   * - false: expects no error
   * - string: expects error containing this message
   */
  isError?: boolean | string | string[];

  /**
   * LLM-as-judge evaluation (toPassToolJudge)
   *
   * Accepts a single judge config or an array for multi-judge evaluation.
   * When an array is provided, all judges must pass (AND semantics).
   */
  passesJudge?: JudgeExpectConfig | JudgeExpectConfig[];

  /**
   * Response size validation (toHaveToolResponseSize)
   */
  responseSize?: {
    /** Maximum allowed size in bytes */
    maxBytes?: number;
    /** Minimum required size in bytes */
    minBytes?: number;
  };

  /**
   * Asserts which tools the LLM called during a host simulation.
   * Only meaningful for mcp_host or external_host runs with high-confidence
   * structured tool evidence — direct mode has no tool call trace.
   */
  toolsTriggered?: {
    /** Expected tool calls */
    calls: Array<{
      /** Tool or explicitly selected host event name. */
      name: string;
      kind?: HostEvent['kind'];
      source?: HostEvent['source'];
      server?: string;
      /** Expected arguments (partial match — extra keys are allowed) */
      arguments?: Record<string, unknown>;
      /** Whether this call MUST have been made (default: true) */
      required?: boolean;
    }>;
    /**
     * 'strict': calls must appear in the exact order listed
     * 'any': calls can appear in any order (default)
     */
    order?: 'strict' | 'any';
    /** If true, no tool calls outside the `calls` list are allowed */
    exclusive?: boolean;
  };

  /**
   * Asserts the number of tool calls made during a host simulation.
```

### `EvalCase`

````typescript snippet=src/evals/datasetTypes.ts#L39-L186
/**
 * A single eval test case
 *
 * For 'direct' mode: toolName and args, or request, are required
 * For 'mcp_host' mode: scenario and mcpHostConfig are required
 * For 'external_host' mode: scenario and externalHost are required
 */
export interface EvalCase {
  /** Optional per-case host override: a built-in or a plugin host. */
  host?: HostConfig;
  /**
   * Unique identifier for this test case
   */
  id: string;

  /**
   * Human-readable description of what this test case validates
   */
  description?: string;

  /**
   * Evaluation mode
   * - 'direct': Direct API calls to MCP tools (default)
   * - 'mcp_host': SDK/CLI host simulation via natural language
   * - 'external_host': Real external MCP host driven by configured capabilities
   *
   * @default 'direct'
   */
  mode?: EvalMode;

  /**
   * Name of the MCP tool to call (required for 'direct' mode, optional for 'mcp_host' mode)
   */
  toolName?: string;

  /**
   * Arguments to pass to the tool (required for 'direct' mode, optional for 'mcp_host' mode)
   */
  args?: Record<string, unknown>;

  /**
   * Direct mode alternative to `toolName`: send any MCP request (for example
   * `skills/get` or `resources/read`) and run the expectations against its
   * JSON result. A JSON-RPC error becomes an error result, so `expect.isError`
   * works as it does for tools. Mutually exclusive with `toolName`.
   *
   * @example { "method": "skills/get", "params": { "uri": "skill://docs/SKILL.md" } }
   */
  request?: EvalDirectRequest;

  /**
   * Natural language scenario for LLM to execute (required for 'mcp_host' and 'external_host' modes)
   *
   * @example "Get the weather for London and tell me if I need an umbrella"
   */
  scenario?: string;

  /**
   * MCP host configuration (optional for 'mcp_host' mode)
   *
   * If not specified, uses default configuration from test environment
   */
  mcpHostConfig?: MCPHostConfig;

  /**
   * External host configuration (required for 'external_host' mode)
   */
  externalHost?: ExternalHostConfig;

  /**
   * Additional metadata for this test case
   *
   * For 'mcp_host' mode, can include 'expectedToolCalls' for validation
   */
  metadata?: Record<string, unknown>;

  /**
   * Number of times to run this case and compute an assertion pass rate.
   * When > 1, `EvalCaseResult.assertionPassRate` is populated and `pass` is determined
   * by `accuracyThreshold` rather than a single run.
   * @default 1
   */
  iterations?: number;

  /**
   * Minimum accuracy (0–1) required to pass when `iterations > 1`.
   * @default 1.0 (all iterations must pass)
   */
  accuracyThreshold?: number;

  /**
   * Number of times to invoke the LLM judge per `passesJudge` assertion.
   * Scores are averaged; the mean must meet the threshold to pass.
   * Reduces judge variance caused by non-determinism.
   * Per-assertion `passesJudge.reps` overrides this value.
   * @default 1
   */
  judgeReps?: number;

  /**
   * Golden/expected answer for this case.
   * When set, automatically passed as `reference` to the LLM judge
   * (unless passesJudge.reference is explicitly provided).
   */
  canonicalAnswer?: string;

  /**
   * What the case expects, for judges: `answer` (the reference answer, which
   * overrides `canonicalAnswer`), `criteria` (rubric criteria keyed by name),
   * and any other ground truth. Judges read it as `case.expected`.
   */
  expected?: {
    answer?: unknown;
    criteria?: Record<string, string>;
    [key: string]: unknown;
  };

  /**
   * Arbitrary string labels for this case.
   * Use for filtering eval runs with `EvalRunnerOptions.filterTags`
   * and for slicing results by category.
   *
   * @example ['tool-finding', 'multi-hop', 'search']
   */
  tags?: string[];

  /**
   * Expectations to validate against the tool response
   *
   * Multiple expectations can be combined and will all be validated.
   *
   * @example
   * ```json
   * {
   *   "id": "weather-london",
   *   "toolName": "get_weather",
   *   "args": { "city": "London" },
   *   "expect": {
   *     "containsText": ["temperature", "conditions"],
   *     "schema": "WeatherResponse",
   *     "responseSize": { "maxBytes": 10000 },
   *     "isError": false
   *   }
   * }
   * ```
   */
  expect?: EvalExpectBlock;
}
````

## Next Steps

- See the [Authentication Guide](./authentication.md) for OAuth and token auth
- See the [Expectations Guide](./expectations.md) for detailed expectation usage
- Check out the [Quick Start Guide](./quickstart.md) for getting started
- Explore [Examples](../examples) for real-world usage patterns
