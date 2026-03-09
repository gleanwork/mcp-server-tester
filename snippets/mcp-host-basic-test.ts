import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { runEvalDataset, loadEvalDataset } from '@gleanwork/mcp-server-tester';

test('LLM triggers the right tool', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });
  expect(result.passed).toBe(result.total);
});
