# API Reference

Complete API documentation for `@gleanwork/mcp-server-tester`.

## Table of Contents

- [Fixtures](#fixtures)
- [Authentication](#authentication)
- [Eval Functions](#eval-functions)
- [Playwright Matchers](#playwright-matchers)
- [Text Utilities](#text-utilities)
- [Judge Functions](#judge-functions)
- [Conformance Functions](#conformance-functions)

## Fixtures

### `mcpClient: Client`

Raw MCP SDK client from `@modelcontextprotocol/sdk`.

```typescript
test('use raw client', async ({ mcpClient }) => {
  const tools = await mcpClient.listTools();
  const result = await mcpClient.callTool({ name: 'tool_name', arguments: { ... } });
});
```

### `mcp: MCPFixtureApi`

High-level test API with helper methods.

```typescript snippet=src/mcp/fixtures/mcpFixture.ts#L82-L124
export interface MCPFixtureApi {
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

- `options: object`
  - `dataset: EvalDataset` - Dataset to run
  - `concurrency?: number` - Max parallel cases (default: 1 = sequential)
  - `judgeClient?: LLMJudgeClient` - Optional LLM judge client
- `context: object`
  - `mcp: MCPFixtureApi` - MCP fixture API
  - `testInfo: TestInfo` - Playwright test info (required for snapshot support)

**Returns:** `Promise<EvalRunnerResult>`

```typescript
const result = await runEvalDataset(
  {
    dataset,
    judgeClient,
  },
  { mcp, testInfo }
);

console.log(`Passed: ${result.passed}/${result.total}`);
```

**Result Structure:**

```typescript snippet=src/evals/evalRunner.ts#L65-L137
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
}
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

Assert that the tool response passes an LLM-as-a-judge evaluation. Requires a judge client to be configured.

```typescript
test('semantic quality', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'authentication' });
  expect(result).toPassToolJudge(
    {
      text: 'The results should be relevant to the query about authentication. Score 0-1.',
    },
    { threshold: 0.7 }
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
// Requires: ANTHROPIC_API_KEY environment variable
```

**With configuration:**

```typescript
const judge = createJudge({
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.0,
});
// Requires: OPENAI_API_KEY environment variable
```

### LLM Host Diagnostic Utilities

The following utilities are available for checking whether optional LLM provider packages are installed. They are useful for debugging provider configuration issues but are not part of the typical test-writing path.

#### `isProviderAvailable(provider)`

Check whether the npm package required for a given `mcp_host` provider is installed in the current environment.

```typescript
import { isProviderAvailable } from '@gleanwork/mcp-server-tester';

if (!isProviderAvailable('anthropic')) {
  console.warn('Install @anthropic-ai/sdk to use the anthropic provider');
}
```

#### `getMissingDependencyMessage(provider)`

Return a human-readable message describing the missing dependency for a provider, suitable for displaying in error output or test skip conditions.

```typescript
import { getMissingDependencyMessage } from '@gleanwork/mcp-server-tester';

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
  - `validateSchemas?: boolean` - Validate tool input schemas (default: `false`)

**Returns:** `Promise<ConformanceResult>`

```typescript
const result = await runConformanceChecks(mcp, {
  requiredTools: ['get_weather', 'search_docs'],
  validateSchemas: true,
});

expect(result.pass).toBe(true);
```

**Result Structure:**

```typescript
interface ConformanceResult {
  pass: boolean;
  checks: Array<{
    name: string;
    pass: boolean;
    message: string;
  }>;
}
```

## Type Definitions

### `EvalExpectBlock`

```typescript snippet=src/evals/datasetTypes.ts#L186-L277
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
   * Asserts which tools the LLM called during a mcp_host simulation.
   * Only meaningful for mcp_host mode — direct mode has no tool call trace.
   */
  toolsTriggered?: {
    /** Expected tool calls */
    calls: Array<{
      /** Tool name */
      name: string;
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
   * Asserts the number of tool calls made during a mcp_host simulation.
   */
  toolCallCount?: {
    /** Minimum number of tool calls */
    min?: number;
    /** Maximum number of tool calls */
    max?: number;
    /** Exact number of tool calls */
    exact?: number;
  };
}
```

### `EvalCase`

````typescript snippet=src/evals/datasetTypes.ts#L27-L139
export interface EvalCase {
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
   * - 'mcp_host': LLM-driven tool selection via natural language
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
   * Natural language scenario for LLM to execute (optional, required for 'mcp_host' mode)
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
   * Mirrors EvalV2's `canonical_answer` field.
   */
  canonicalAnswer?: string;

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

### `EvalDataset`

```typescript
interface EvalDataset {
  name: string;
  description?: string;
  cases: EvalCase[];
  metadata?: Record<string, unknown>;
  schemas?: Record<string, ZodSchema>; // Zod schemas for toMatchToolSchema assertions
}
```

### `EvalExpectation`

```typescript
type EvalExpectation = (
  context: { mcp: MCPFixtureApi },
  evalCase: EvalCase,
  response: CallToolResult
) => Promise<{ pass: boolean; details: string }>;
```

## Next Steps

- See the [Authentication Guide](./authentication.md) for OAuth and token auth
- See the [Expectations Guide](./expectations.md) for detailed expectation usage
- Check out the [Quick Start Guide](./quickstart.md) for getting started
- Explore [Examples](../examples) for real-world usage patterns
