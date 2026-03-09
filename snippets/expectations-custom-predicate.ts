import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('response contains at least three results', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'setup' });

  await expect(result).toSatisfyToolPredicate((response, text) => {
    const matches = text.match(/^##\s/gm);
    return {
      pass: matches !== null && matches.length >= 3,
      message: `Expected at least 3 result sections, found ${matches?.length ?? 0}`,
    };
  }, 'minimum result count');
});
