import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runEvalDataset,
  saveBaseline,
  loadBaseline,
} from '@gleanwork/mcp-server-tester';

// Capture a baseline after a known-good run.
// Run this once on your main branch before making changes.
test('capture baseline', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      saveResultsTo: '.mcp-test-results/baseline.json',
    },
    { mcp, testInfo }
  );

  expect(result.passed).toBe(result.total);
});

// Re-run after code or description changes and compare against the baseline.
test('detect regressions', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  const result = await runEvalDataset(
    {
      dataset,
      baselineResultsFrom: '.mcp-test-results/baseline.json',
    },
    { mcp, testInfo }
  );

  // Fail the test if any previously passing case now fails.
  expect(result.regressions).toBe(0);

  // Log a summary of the comparison.
  if (result.deltaPassRate !== undefined) {
    const delta = (result.deltaPassRate * 100).toFixed(1);
    const sign = result.deltaPassRate >= 0 ? '+' : '';
    console.log(`Pass rate delta vs baseline: ${sign}${delta}%`);
    console.log(`Regressions: ${result.regressions ?? 0}`);
    console.log(`Improvements: ${result.improvements ?? 0}`);
  }
});

// Use saveBaseline and loadBaseline directly for custom scripting.
test('manual baseline management', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  // Write the result as the new baseline.
  await saveBaseline(result, '.mcp-test-results/baseline.json');

  // Load it back and inspect it.
  const saved = await loadBaseline('.mcp-test-results/baseline.json');
  console.log(`Baseline has ${saved.total} cases, ${saved.passed} passing`);
});
