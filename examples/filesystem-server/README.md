# Filesystem MCP Server Example

Comprehensive testing example for the official [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) using `@gleanwork/mcp-server-tester`.

## What This Example Demonstrates

This is the **canonical example** showing all testing patterns organized into three layers:

### Unit/Integration Testing (no LLM required)

1. **Protocol Conformance** - Validate MCP protocol compliance
2. **Tool Tests** - Call tools directly and assert with the matchers

### Data-Driven Testing (JSON)

3. **Tool checks** - One test per entry in `tool-checks.json`

### End-to-End / Functional Testing (requires LLM API keys)

4. **Evals on a model** - Single cases on the `mst` client, written in code
5. **Evals** - One test per case in `eval-dataset.json`, on a model

## Quick Start

```bash
npm install
npm test
```

## The Testing Pyramid

```
                    ┌─────────────────────┐
                    │   LLM Client E2E      │  ← Real LLM discovers & calls tools
                    │   (functional)      │     Requires API keys
                    ├─────────────────────┤
                    │   Data-Driven       │  ← JSON datasets + assertions
                    │   (eval datasets)   │     No LLM required
                    ├─────────────────────┤
                    │   Direct API        │  ← Tool calls + assertions
                    │   (unit/integration)│     No LLM required
                    └─────────────────────┘
```

## Test Patterns

### 1. Direct API Testing

Call MCP tools directly - validates tool implementation:

```typescript
test('reads a file', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: 'readme.txt' });

  expect(result.isError).not.toBe(true);

  const text = extractText(result);
  expect(text).toBe('Hello World');
});
```

### 2. Data-Driven Tool Tests (JSON)

`tool-checks.json` keeps tool calls and what they must return; the spec turns each into a test:

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

### 3. Evals on a Model (E2E Functional)

Test how MCP servers are **really used**: a model gets the tools and an input, and decides which to call. `runEvalCase` runs one case on the `mst` client:

```typescript
test('a model discovers and lists directory contents', async ({ mcp }) => {
  const result = await runEvalCase(
    {
      id: 'list-docs',
      input: 'What files are in the docs directory?',
      assertions: {
        toolsTriggered: { calls: [{ name: 'list_directory' }] },
        containsText: ['guide', 'api'],
      },
    },
    { mcp },
    { client: 'mst', model: 'claude-sonnet-4-5' }
  );
  expect(result.pass, result.error).toBe(true);
});
```

### 4. Evals (JSON)

`eval-dataset.json` holds eval cases: an input a model acts on, and assertions about what it did:

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

## Project Structure

```
filesystem-server/
├── tests/
│   └── filesystem-eval.spec.ts  # All 8 test patterns
├── schemas/
│   └── fileContentSchema.ts     # Zod schemas for validation
├── eval-dataset.json            # 5 eval cases, run on a model
├── tool-checks.json             # 8 data-driven tool tests
├── package.json
├── playwright.config.ts
└── README.md
```

## Running LLM Tests

LLM client tests require an Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-key npm test
```

## See Also

- **[basic-playwright-usage](../basic-playwright-usage/)** - Minimal starter example
- **[sqlite-server](../sqlite-server/)** - Database testing example
