# MCP Server Testing Examples

Complete working examples demonstrating how to use `@gleanwork/mcp-server-tester` for testing MCP servers.

## The Testing Pyramid

```
                    ┌─────────────────────┐
                    │   LLM Host E2E      │  ← Real LLM discovers & calls tools
                    │   (functional)      │     Requires API keys
                    ├─────────────────────┤
                    │   Data-Driven       │  ← JSON datasets + expectations
                    │   (eval datasets)   │     No LLM required
                    ├─────────────────────┤
                    │   Direct API        │  ← Tool calls + assertions
                    │   (unit/integration)│     No LLM required
                    └─────────────────────┘
```

## Examples

| Example                                             | Description                           | Complexity |
| --------------------------------------------------- | ------------------------------------- | ---------- |
| [basic-playwright-usage](./basic-playwright-usage/) | Minimal starter (~60 lines)           | ⭐         |
| [filesystem-server](./filesystem-server/)           | **Canonical example** - all patterns  | ⭐⭐⭐     |
| [sqlite-server](./sqlite-server/)                   | Database testing with custom fixtures | ⭐⭐       |
| [glean-server](./glean-server/)                     | Production HTTP server testing        | ⭐⭐       |

## Quick Start

```bash
# Start with the minimal example
cd examples/basic-playwright-usage
npm install
npm test

# Then explore the full example
cd examples/filesystem-server
npm install
npm test
```

## Testing Patterns

### Layer 1: Direct API Testing (Unit/Integration)

Call MCP tools directly - validates tool implementation:

```typescript
test('reads a file', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: 'readme.txt' });

  expect(result.isError).not.toBe(true);
  expect(extractText(result)).toBe('Hello World');
});
```

### Layer 2: Inline Eval Cases

Define eval cases in code with expectations - same expectations, no JSON:

```typescript
test('validates config', async ({ mcp }) => {
  const result = await runEvalCase(
    {
      id: 'config-check',
      toolName: 'read_file',
      args: { path: 'config.json' },
      expectedTextContains: ['version', '1.0.0'],
    },
    { textContains: createTextContainsExpectation() },
    { mcp }
  );

  expect(result.pass).toBe(true);
});
```

### Layer 3: Data-Driven Tests (JSON)

Load test cases from JSON files for maintainability:

```typescript
const dataset = await loadEvalDataset('./eval-dataset.json');

const result = await runEvalDataset(
  { dataset, expectations: { textContains: createTextContainsExpectation() } },
  { mcp, testInfo, expect }
);

expect(result.passed).toBe(result.total);
```

### Layer 4: LLM Host Simulation (E2E Functional)

Test how MCP servers are **really used** - an LLM discovers tools and calls them:

```typescript
test('LLM discovers directory contents', async ({ mcp }) => {
  const result = await simulateMCPHost(
    mcp,
    'What files are in the docs directory?',
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', temperature: 0 }
  );

  expect(result.success).toBe(true);
  expect(result.toolCalls.length).toBeGreaterThan(0);
  expect(result.response).toContain('guide');
});
```

## Example Comparison

| Feature             | basic | filesystem | sqlite | glean |
| ------------------- | ----- | ---------- | ------ | ----- |
| Transport           | stdio | stdio      | stdio  | HTTP  |
| Direct API Tests    | ✓     | ✓          | ✓      | ✓     |
| Inline Eval Cases   | ✗     | ✓          | ✗      | ✗     |
| JSON Eval Datasets  | ✗     | ✓          | ✓      | ✓     |
| LLM Host Simulation | ✗     | ✓          | ✗      | ✗     |
| LLM Host from JSON  | ✗     | ✓          | ✓      | ✓     |
| MCP Reporter        | ✗     | ✓          | ✗      | ✓     |

## Running LLM Tests

LLM host tests require an Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-key npm test
```

**Cost note**: LLM host mode incurs API costs. Use direct mode for most tests.

## Learn More

- [Main Documentation](../README.md)
- [MCP Protocol](https://modelcontextprotocol.io)
- [Playwright Test](https://playwright.dev/docs/test-intro)
