import { test as base } from '@playwright/test';
import {
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
  runConformanceChecks,
  extractText,
  type MCPConfig,
  type MCPFixtureApi,
  // Extended expect with MCP tool matchers
  expect,
} from '@gleanwork/mcp-server-tester';
import { tmpdir } from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';

const test = base.extend<{ mcp: MCPFixtureApi; tempDir: string }>({
  tempDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
    await writeFile(join(dir, 'hello.txt'), 'Hello, MCP!');
    await use(dir);
    await rm(dir, { recursive: true });
  },

  mcp: async ({ tempDir }, use, testInfo) => {
    const config: MCPConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
      cwd: tempDir,
      quiet: true,
    };

    const client = await createMCPClientForConfig(config);
    const mcp = createMCPFixture(client, testInfo);
    await use(mcp);
    await closeMCPClient(client);
  },
});

test.describe('Basic MCP Server Tests', () => {
  test('lists available tools', async ({ mcp }) => {
    const tools = await mcp.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('read_file');
  });

  test('calls a tool and gets a response', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'hello.txt' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    expect(text).toBe('Hello, MCP!');
  });

  test('handles errors gracefully', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'nonexistent.txt' });

    expect(result.isError).toBe(true);
  });

  test('passes protocol conformance checks', async ({ mcp }) => {
    const result = await runConformanceChecks(mcp, {
      requiredTools: ['read_file', 'list_directory'],
    });

    const passed = result.checks.filter((c) => c.pass).length;
    expect(passed).toBeGreaterThanOrEqual(3);
  });
});

/**
 * NEW: Matcher-Based API
 *
 * These tests demonstrate the new Playwright matcher-based approach.
 * Cleaner and follows standard Playwright conventions.
 */
test.describe('Matcher-Based Tests (NEW)', () => {
  test('reads file with matchers', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'hello.txt' });

    // Use new matchers - cleaner syntax
    expect(result).not.toBeToolError();
    expect(result).toContainToolText('Hello, MCP!');
  });

  test('validates error responses', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'nonexistent.txt' });

    expect(result).toBeToolError();
  });
});
