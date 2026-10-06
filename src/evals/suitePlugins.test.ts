import { describe, expect, it } from 'vitest';
import { assertDatasetNamespaces } from './suitePlugins.js';
import type { EvalDataset } from './datasetTypes.js';

function dataset(extra: Partial<EvalDataset> = {}): EvalDataset {
  return { name: 'suite-data', cases: [], ...extra };
}

describe('assertDatasetNamespaces', () => {
  it.each([
    [
      'a case judge',
      dataset({
        cases: [
          {
            id: 'a',
            toolName: 't',
            args: {},
            assertions: { passesJudge: { judge: 'other/x' } },
          },
        ],
      }),
    ],
    [
      'a case host',
      dataset({
        cases: [
          { id: 'a', input: 's', host: { type: 'other/desk' } },
        ] as EvalDataset['cases'],
      }),
    ],
  ])('rejects %s from a namespace the suite does not load', (_, value) => {
    expect(() => assertDatasetNamespaces(value, ['acme'])).toThrow(
      `Dataset "suite-data" references "other/`
    );
    expect(() => assertDatasetNamespaces(value, ['other'])).not.toThrow();
  });

  it('allows built-in references', () => {
    const value = dataset({
      cases: [
        { id: 'a', input: 's', host: { type: 'claude-code' } },
      ] as EvalDataset['cases'],
    });
    expect(() => assertDatasetNamespaces(value, [])).not.toThrow();
  });
});
