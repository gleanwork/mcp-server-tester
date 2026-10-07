import { test, expect } from '../src/fixtures/mcp.js';
import { runConformanceChecks } from '../src/spec/conformanceChecks.js';
import { z } from 'zod';

test.describe('MCP Server Tests', () => {
  test('should connect to MCP server and get server info', async ({ mcp }) => {
    const serverInfo = mcp.getServerInfo();
    expect(serverInfo).toBeTruthy();
  });

  test('should list available tools', async ({ mcp }) => {
    const tools = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  test('should run conformance checks', async ({ mcp }) => {
    const result = await runConformanceChecks(mcp, {
      validateSchemas: true,
      checkServerInfo: true,
    });

    expect(result.pass).toBe(true);

    // Verify raw responses are returned for snapshotting
    expect(result.raw).toBeDefined();
    expect(result.raw.serverInfo).toBeTruthy();
    expect(result.raw.serverInfo?.name).toBe('test-mcp-server');
    expect(result.raw.capabilities).toBeTruthy();
    expect(result.raw.tools).toHaveLength(4);
    expect(result.raw.tools.map((t) => t.name)).toContain('echo');
    expect(result.raw.tools.map((t) => t.name)).toContain('calculate');
    expect(result.raw.tools.map((t) => t.name)).toContain('get_weather');
  });

  // Tool checks are Playwright tests: call the tool, assert with the matchers.
  const WeatherResponseSchema = z.object({
    city: z.string(),
    temperature: z.number(),
    conditions: z.string(),
  });

  for (const city of ['London', 'Tokyo']) {
    test(`get_weather for ${city} matches its schema`, async ({ mcp }) => {
      const result = await mcp.callTool('get_weather', { city });
      expect(result).toMatchToolSchema(WeatherResponseSchema);
    });
  }

  test('calculate adds two numbers', async ({ mcp }) => {
    const result = await mcp.callTool('calculate', {
      operation: 'add',
      a: 10,
      b: 20,
    });
    expect(result).toContainToolText('30');
  });

  // The mock indents its markdown, so line patterns allow leading space.
  test('get_city_info answers in sectioned markdown', async ({ mcp }) => {
    const result = await mcp.callTool('get_city_info', { city: 'London' });
    expect(result).toContainToolText([
      '## City Information',
      '**City:** London',
      '### Features',
      '- Public Transportation',
    ]);
    expect(result).toMatchToolPattern([
      /^## City Information/m,
      /\*\*City:\*\* \w+/,
      /\*\*Population:\*\* [\d.]+M/,
      /^\s*### Features/m,
      /^\s*- [\w\s]+/m,
      /Temperature: \d+°C/,
      /\d{4}-\d{2}-\d{2}/,
    ]);
  });

  test('echo tool returns expected text (toContainToolText)', async ({
    mcp,
  }) => {
    const result = await mcp.callTool('echo', { message: 'Hello World' });
    expect(result).toContainToolText('Echo: Hello World');
  });

  test('get_weather tool returns city name and conditions (toContainToolText)', async ({
    mcp,
  }) => {
    const result = await mcp.callTool('get_weather', { city: 'London' });
    expect(result).toContainToolText('London');
    expect(result).toContainToolText('Sunny');
  });

  test('nonexistent tool returns an error (toBeToolError)', async ({ mcp }) => {
    const result = await mcp.callTool('nonexistent_tool', {});
    expect(result).toBeToolError();
  });
});
