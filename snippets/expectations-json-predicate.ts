import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('JSON content is parseable', async ({ mcp }) => {
  const result = await mcp.callTool('get_config', {});

  await expect(result).toSatisfyToolPredicate((response, text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return { pass: false, message: 'Response text is not valid JSON' };
    }
  });
});
