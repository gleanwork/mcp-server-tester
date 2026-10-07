import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('my evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/my-evals.json');

  const _result = await runEvalDataset(
    {
      dataset,

      // The client the cases run on and its model. A case can set its
      // own client, model and clientOptions.
      client: 'mst',
      model: 'claude-haiku-4-5',

      // Run every client case 10 times, unless it sets its own trials
      defaultTrials: 10,

      // Run up to 3 cases at once (careful with rate limits)
      concurrency: 3,
    },
    { mcp, testInfo }
  );

  // result.passed / result.total gives overall pass rate
  // result.caseResults[i].accuracy gives per-case accuracy
  // result.caseResults[i].iterationResults gives per-run breakdown
});
