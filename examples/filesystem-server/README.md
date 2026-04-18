# Filesystem MCP Server Example

Comprehensive testing example for the official [Filesystem MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) using `@gleanwork/mcp-server-tester`.

## What This Example Demonstrates

This is the **canonical example** showing all testing patterns organized into three layers:

### Unit/Integration Testing (no LLM required)

1. **Protocol Conformance** - Validate MCP protocol compliance
2. **Direct API Testing** - Call tools directly with assertions
3. **Inline Eval Cases** - Define eval cases in code with expectations

### Data-Driven Testing (JSON datasets)

4. **Eval Dataset (Batch)** - Run all cases from JSON together
5. **Individual Eval Cases** - Generate one test per JSON case

### End-to-End / Functional Testing (requires LLM API keys)

6. **LLM Host Simulation** - Test real MCP usage with LLM tool discovery
7. **LLM Host from JSON** - Data-driven LLM host tests

## Quick Start

```bash
npm install
npm test
```

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

### 2. Inline Eval Cases (Code-Defined)

Define eval cases in code with expectations - no JSON needed:

```typescript
test('validates config with inline case', async ({ mcp }) => {
  const result = await runEvalCase(
    {
      id: 'inline-config-check',
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

### 3. LLM Host Simulation (E2E Functional)

Test how MCP servers are **really used** - an LLM discovers tools and decides how to use them:

```typescript
test('LLM discovers and lists directory contents', async ({ mcp }) => {
  // Simulate real MCP usage: natural language → LLM → tool calls
  const result = await simulateMCPHost(
    mcp,
    'What files are in the docs directory?',
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', temperature: 0 }
  );

  expect(result.success).toBe(true);
  expect(result.toolCalls.length).toBeGreaterThan(0);

  // Validate the LLM chose the right tool
  const listDirCall = result.toolCalls.find((c) => c.name === 'list_directory');
  expect(listDirCall).toBeDefined();

  // Validate the response
  expect(result.response).toContain('guide');
});
```

### 4. Data-Driven Tests (JSON)

Define test cases in JSON for maintainability:

```json
{
  "id": "should read readme.txt file",
  "mode": "direct",
  "toolName": "read_file",
  "args": { "path": "readme.txt" },
  "expectedTextContains": "Hello World"
}
```

```typescript
const dataset = await loadEvalDataset('./eval-dataset.json');

const result = await runEvalDataset(
  { dataset, expectations: { textContains: createTextContainsExpectation() } },
  { mcp, testInfo, expect }
);

expect(result.passed).toBe(result.total);
```

## Project Structure

```
filesystem-server/
├── tests/
│   └── filesystem-eval.spec.ts  # All 8 test patterns
├── schemas/
│   └── fileContentSchema.ts     # Zod schemas for validation
├── eval-dataset.json            # 13 test cases (8 direct, 5 LLM)
├── package.json
├── playwright.config.ts
└── README.md
```

## Running LLM Tests

LLM host tests require an Anthropic API key:

```bash
ANTHROPIC_API_KEY=your-key npm test
```

## See Also

- **[basic-playwright-usage](../basic-playwright-usage/)** - Minimal starter example
- **[sqlite-server](../sqlite-server/)** - Database testing example
