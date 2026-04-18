# Basic Playwright Usage Example

The simplest possible example of testing an MCP server with `@gleanwork/mcp-server-tester`.

## What This Example Demonstrates

- ✅ Creating MCP fixtures for Playwright
- ✅ Connecting to an MCP server (stdio transport)
- ✅ Calling tools and validating responses
- ✅ Running protocol conformance checks
- ✅ Error handling

## Quick Start

```bash
npm install
npm test
```

## Project Structure

```
basic-playwright-usage/
├── tests/
│   └── basic.spec.ts      # 4 simple tests (~60 lines)
├── package.json
├── playwright.config.ts
└── README.md
```

## The Code

The entire test file is ~60 lines. Here's the core pattern:

### 1. Create Fixtures

```typescript
const test = base.extend<{ mcp: MCPFixtureApi }>({
  mcp: async ({}, use, testInfo) => {
    const config: MCPConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    };

    const client = await createMCPClientForConfig(config);
    const mcp = createMCPFixture(client, testInfo);
    await use(mcp);
    await closeMCPClient(client);
  },
});
```

### 2. Write Tests

```typescript
test('calls a tool', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: 'hello.txt' });

  expect(result.isError).not.toBe(true);

  const text = extractText(result);
  expect(text).toBe('Hello, MCP!');
});
```

## Next Steps

Once you understand the basics, check out:

- **[filesystem-server](../filesystem-server/)** - Comprehensive example with eval datasets
- **[sqlite-server](../sqlite-server/)** - Database testing with custom fixtures
