# MCP Server Testing Examples

Complete working examples demonstrating how to use `@gleanwork/mcp-server-tester` for testing MCP servers.

## The Testing Pyramid

```
                    ┌─────────────────────┐
                    │   Evals             │  ← A client and model pick the tools
                    │   (eval-dataset)    │     Requires API keys
                    ├─────────────────────┤
                    │   Data-driven tests │  ← tool-checks.json, one test each
                    │   (Playwright)      │     No LLM required
                    ├─────────────────────┤
                    │   Tool tests        │  ← Tool calls + matchers
                    │   (Playwright)      │     No LLM required
                    └─────────────────────┘
```

## Examples

| Example                                             | Description                           | Complexity |
| --------------------------------------------------- | ------------------------------------- | ---------- |
| [basic-playwright-usage](./basic-playwright-usage/) | Minimal starter (~60 lines)           | ⭐         |
| [filesystem-server](./filesystem-server/)           | **Canonical example** - all patterns  | ⭐⭐⭐     |
| [sqlite-server](./sqlite-server/)                   | Database testing with custom fixtures | ⭐⭐       |

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

### Layer 2: Data-Driven Tool Tests (JSON)

Keep tool calls and what they must return in JSON, and turn each into a test:

```json
{
  "name": "should read readme.txt file",
  "tool": "read_file",
  "args": { "path": "readme.txt" },
  "containsText": "Hello World",
  "isError": false
}
```

```typescript
import toolChecks from '../tool-checks.json' with { type: 'json' };

for (const check of toolChecks.checks) {
  test(check.name, async ({ mcp }) => {
    const result = await mcp.callTool(check.tool, check.args);
    if (check.isError === false) expect(result).not.toBeToolError();
    if (check.containsText)
      expect(result).toContainToolText(check.containsText);
    // ...one matcher per field: see tests/filesystem-eval.spec.ts
  });
}
```

### Layer 3: Evals (E2E Functional)

Test how MCP servers are **really used**: a client and its model get each case's input and pick the tools. The assertions check what it did:

```typescript
test('a model picks the right tools', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./eval-dataset.json');
  const result = await runEvalDataset(
    { dataset, client: 'mst', model: 'claude-sonnet-4-5' },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
```

## Example Comparison

| Feature           | basic | filesystem | sqlite |
| ----------------- | ----- | ---------- | ------ |
| Transport         | stdio | stdio      | stdio  |
| Tool tests        | ✓     | ✓          | ✓      |
| Data-driven tests | ✗     | ✓          | ✓      |
| Evals on a model  | ✗     | ✓          | ✗      |
| MCP Reporter      | ✗     | ✓          | ✗      |

## Running LLM Tests

Evals require an Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-key npm test
```

**Cost note**: evals incur API costs. Use tool tests for most checks.

## Learn More

- [Main Documentation](../README.md)
- [MCP Protocol](https://modelcontextprotocol.io)
- [Playwright Test](https://playwright.dev/docs/test-intro)
