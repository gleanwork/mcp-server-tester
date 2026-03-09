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

```typescript
interface MCPFixtureApi {
  client: Client;
  listTools(): Promise<Array<Tool>>;
  callTool<TArgs>(name: string, args: TArgs): Promise<CallToolResult>;
  getServerInfo(): { name?: string; version?: string } | null;
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

```typescript
interface EvalRunnerResult {
  total: number;
  passed: number;
  failed: number;
  caseResults: Array<EvalCaseResult>;
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

```typescript
interface EvalExpectBlock {
  response?: unknown; // Exact response match
  schema?: string; // Schema name to validate against
  containsText?: string | string[]; // Text substrings that must be present
  matchesPattern?: string | string[]; // Regex patterns that must match
  snapshot?: string; // Snapshot name for comparison
  snapshotSanitizers?: SnapshotSanitizer[]; // Sanitizers for snapshot
  isError?: boolean | string | string[]; // Error expectation
  passesJudge?: {
    // LLM-as-judge evaluation
    rubric:
      | 'correctness'
      | 'completeness'
      | 'groundedness'
      | 'instruction-following'
      | 'conciseness'
      | { text: string };
    reference?: unknown;
    threshold?: number;
    configId?: string;
  };
  responseSize?: {
    // Size validation
    maxBytes?: number;
    minBytes?: number;
  };
  toolsTriggered?: {
    // Tool call assertion (mcp_host mode)
    calls: Array<{
      name: string;
      arguments?: Record<string, unknown>;
      required?: boolean;
    }>;
    order?: 'strict' | 'any';
    exclusive?: boolean;
  };
  toolCallCount?: {
    // Tool call count (mcp_host mode)
    min?: number;
    max?: number;
    exact?: number;
  };
}
```

### `EvalCase`

```typescript
interface EvalCase {
  // Required
  id: string;               // Unique identifier

  // Mode selection
  mode?: 'direct' | 'mcp_host'; // Default: 'direct'

  // direct mode — tool name and args required
  toolName?: string;
  args?: Record<string, unknown>;

  // mcp_host mode — scenario required; LLM decides which tool to call
  scenario?: string;
  mcpHostConfig?: MCPHostConfig;

  // Shared optional fields
  description?: string;
  expect?: EvalExpectBlock;
  metadata?: Record<string, unknown>;
  tags?: string[];          // For filtering/slicing results

  // Multi-iteration accuracy
  iterations?: number;          // Run N times (default: 1)
  accuracyThreshold?: number;   // Min pass rate 0–1 (default: 1.0)

  // LLM judge options
  judgeReps?: number;           // Judge invocations per assertion (default: 1)
  canonicalAnswer?: string;     // Golden answer passed to judge as reference
}
```

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
