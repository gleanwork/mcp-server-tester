import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

const resultStore = {
  provider: 'gcs' as const,
  bucket: 'my-mcp-eval-results',
  prefix: 'my-server/baselines',
};

test('save latest baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      resultStore,
      saveResultsTo: { store: true, ref: 'latest' },
    },
    { mcp, testInfo }
  );

  expect(result.failed).toBe(0);
});

test('compare against latest baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      resultStore,
      baselineResultsFrom: { store: true, ref: 'latest' },
    },
    { mcp, testInfo }
  );

  expect(result.regressions ?? 0).toBe(0);
});
