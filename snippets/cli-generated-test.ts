import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('lists tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});
