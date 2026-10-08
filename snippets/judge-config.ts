import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

// Each case lists its judges, with their LLM settings, in `judges`.
test('search relevance eval with judge', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset(
    { dataset, client: 'mst', model: 'claude-haiku-4-5' },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
