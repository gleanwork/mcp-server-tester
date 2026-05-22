import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runServerComparison,
} from '@gleanwork/mcp-server-tester';

test('compare two MCP servers and persist the result', async ({
  mcp,
}, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const otherMcp = mcp;

  await runServerComparison(
    {
      dataset,
      comparisonStore: {
        provider: 'gcs',
        bucket: 'my-mcp-eval-results',
        prefix: 'my-server/server-comparisons',
      },
      comparisonId: `server-comparison-${Date.now()}`,
    },
    { mcp, testInfo },
    { mcp: otherMcp, testInfo }
  );
});
