import { describe, expect, it } from 'vitest';
import { runEvalCase, runEvalDataset } from './evalRunner.js';
import type { EvalContext } from './evalRunner.js';
import { runToolOptimization } from './toolOptimization.js';
import { olderResultsError } from './resultFormat.js';

// The guards run before anything connects, so no MCP connection is needed.
const context = {} as EvalContext;
const dataset = { name: 'd', cases: [] };

describe('2.0 run option names', () => {
  it.each([
    ['mcpHostModel', 'model'],
    ['toolOverrideVariantId', 'toolVariantId'],
  ])('runEvalDataset rejects %s with %s', async (from, to) => {
    await expect(
      runEvalDataset(
        { dataset, [from]: 'x' } as Parameters<typeof runEvalDataset>[0],
        context
      )
    ).rejects.toThrow(`runEvalDataset: \`${from}\` is now \`${to}\`.`);
  });

  it('runEvalCase rejects the old option names', async () => {
    await expect(
      runEvalCase({ id: 'c', input: 'hi' }, context, {
        mcpHostModel: 'x',
      } as Parameters<typeof runEvalCase>[2])
    ).rejects.toThrow('runEvalCase: `mcpHostModel` is now `model`.');
  });

  it('runToolOptimization rejects mcpHostModel', async () => {
    await expect(
      runToolOptimization({
        dataset,
        variants: [],
        mcpHostModel: 'x',
      } as never)
    ).rejects.toThrow('runToolOptimization: `mcpHostModel` is now `model`.');
  });
});

describe('olderResultsError', () => {
  it('asks to upgrade MST for a newer result format', () => {
    expect(olderResultsError('Stored x', 'mst.run/v2').message).toBe(
      'Stored x was written by a newer MST (mst.run/v2). Upgrade MST to read it.'
    );
  });
});
