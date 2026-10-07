import { describe, expect, it } from 'vitest';
import { assertDatasetNamespaces } from './evalPlugins.js';
import type { EvalDataset } from './datasetTypes.js';

function dataset(extra: Partial<EvalDataset> = {}): EvalDataset {
  return { name: 'eval-data', cases: [], ...extra };
}

describe('assertDatasetNamespaces', () => {
  it.each([
    [
      'a case judge',
      dataset({
        cases: [
          {
            id: 'a',
            input: 'x',
            assertions: { passesJudge: { judge: 'other/x' } },
          },
        ],
      }),
    ],
    [
      'a case client',
      dataset({
        cases: [
          { id: 'a', input: 's', client: 'other/desk' },
        ] as EvalDataset['cases'],
      }),
    ],
  ])('rejects %s from a namespace the eval does not load', (_, value) => {
    expect(() => assertDatasetNamespaces(value, ['acme'])).toThrow(
      `Dataset "eval-data" references "other/`
    );
    expect(() => assertDatasetNamespaces(value, ['other'])).not.toThrow();
  });

  it('allows built-in references', () => {
    const value = dataset({
      cases: [
        { id: 'a', input: 's', client: 'claude-code' },
      ] as EvalDataset['cases'],
    });
    expect(() => assertDatasetNamespaces(value, [])).not.toThrow();
  });
});
