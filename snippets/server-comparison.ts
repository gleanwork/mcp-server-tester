import { test } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runServerComparison,
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
} from '@gleanwork/mcp-server-tester';

test('compare two server versions', async ({ mcp: mcpA }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');

  // Build a second MCP context for server B.
  const clientB = await createMCPClientForConfig({
    transport: 'stdio',
    command: 'node',
    args: ['server-v2.js'],
  });
  const mcpB = createMCPFixture(clientB);

  try {
    const comparison = await runServerComparison(
      { dataset },
      { mcp: mcpA, testInfo },
      { mcp: mcpB }
    );

    console.log(`Total cases compared: ${comparison.total}`);
    console.log(
      `Server A win rate: ${(comparison.aWinRate * 100).toFixed(1)}%`
    );
    console.log(
      `Server B win rate: ${(comparison.bWinRate * 100).toFixed(1)}%`
    );
    console.log(`Tie rate: ${(comparison.tieRate * 100).toFixed(1)}%`);
    console.log(
      `Both failed: ${comparison.bothFail} cases (${(comparison.failureAlignment * 100).toFixed(1)}% failure alignment)`
    );

    // Inspect decisive per-case outcomes.
    for (const c of comparison.cases) {
      if (c.outcome !== 'TIE' && c.outcome !== 'BOTH_FAIL') {
        console.log(`  ${c.id}: ${c.outcome}`);
      }
    }
  } finally {
    await closeMCPClient(clientB);
  }
});
