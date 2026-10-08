import { describe, expect, it } from 'vitest';
import { buildEvalDataset } from './buildEvalDataset.js';
import type { EvalConfig } from './evalConfig.js';

const evalConfig: EvalConfig = {
  name: 'test',
  datasets: [{ type: 'file', path: 'x.json' }],
};

describe('buildEvalDataset canonical ingestion', () => {
  it('accepts minimal cases without assertions or a client, and rejects a case without input', () => {
    const raw = { name: 'canonical', cases: [{ id: 'a', input: 'Find it' }] };
    expect(buildEvalDataset(raw, evalConfig).cases).toEqual(raw.cases);
    expect(() =>
      buildEvalDataset({ name: 'canonical', cases: [{ id: 'b' }] }, evalConfig)
    ).toThrow(/input/);
  });

  it.each([
    {
      id: 'a',
      input: 'Find policy',
      client: 'custom-host',
      clientOptions: { option: true },
    },
    {
      id: 'a',
      input: 'Find policy',
    },
  ])('preserves a case and its own client: $client', (case_) => {
    const dataset = buildEvalDataset(
      {
        name: 'canonical',
        cases: [{ ...case_, trials: 2, passThreshold: 0.75 }],
      },
      { ...evalConfig, trials: 9, client: 'different-host' }
    );
    expect(dataset.cases[0]).toEqual({
      ...case_,
      trials: 2,
      passThreshold: 0.75,
    });
  });

  it('preserves explicit custom judge assertions without applying eval config policy', () => {
    const case_ = {
      id: 'a',
      input: 'Find it',
      judges: [{ type: 'my-judge', reference: 'answer', threshold: 0.7 }],
    };
    expect(
      buildEvalDataset(
        { name: 'canonical', cases: [case_] },
        {
          ...evalConfig,
          judges: [{ type: 'another-judge' }],
        }
      ).cases[0]
    ).toEqual(case_);
  });

  it.each([
    { id: 'a', input: 'find policy', expected_tool: 'search' },
    { id: 'a', tool: 'search', assertions: { isError: false } },
    {
      id: 'a',
      input: 'find policy',
      expected_tool: 'search',
    },
    { id: 'a', toolName: 'search', tool: 'other' },
  ])('rejects legacy inputs clearly without a source adapter: $id', (case_) => {
    expect(() =>
      buildEvalDataset({ name: 'legacy', cases: [case_] }, evalConfig)
    ).toThrow(/canonical EvalDataset.*explicit dataset source adapter/);
  });

  it('reads a case with input as a client case', () => {
    expect(
      buildEvalDataset(
        { name: 'question', cases: [{ id: 'a', input: 'find policy' }] },
        evalConfig
      ).cases
    ).toEqual([{ id: 'a', input: 'find policy' }]);
  });

  it('validates every case, even after maxCases and a canonical first case', () => {
    expect(() =>
      buildEvalDataset(
        {
          name: 'mixed',
          cases: [
            { id: 'good', input: 'Find it' },
            {
              id: 'legacy',
              input: 'Find policy',
              expected_tool: 'search',
            },
          ],
        },
        { ...evalConfig, maxCases: 1 }
      )
    ).toThrow(/expected_tool/);
  });

  it('reports invalid canonical cases and empty datasets', () => {
    expect(() =>
      buildEvalDataset(
        { name: 'bad', cases: [{ id: 'a', input: 123 }] },
        evalConfig
      )
    ).toThrow(/input/);
    expect(() =>
      buildEvalDataset({ name: 'empty', cases: [] }, evalConfig)
    ).toThrow(/at least one case/);
  });

  it('applies tag selection before nested run.maxCases without changing source data', () => {
    const raw = {
      name: 'tagged',
      cases: [
        { id: 'skip', input: 'Find it', tags: ['other'] },
        { id: 'keep', input: 'Find it', tags: ['wanted'] },
        { id: 'limit', input: 'Find it', tags: ['wanted'] },
      ],
    };
    expect(
      buildEvalDataset(raw, {
        ...evalConfig,
        filterTags: ['wanted'],
        run: { maxCases: 1 },
      }).cases.map((entry) => entry.id)
    ).toEqual(['keep']);
    expect(raw.cases).toHaveLength(3);
  });

  it('truncates validated canonical datasets to maxCases', () => {
    expect(
      buildEvalDataset(
        {
          name: 'canonical',
          cases: [
            { id: 'a', input: 'Find it' },
            { id: 'b', input: 'Find it' },
          ],
        },
        { ...evalConfig, maxCases: 1 }
      ).cases.map((case_) => case_.id)
    ).toEqual(['a']);
  });
});

describe('dataset errors', () => {
  it('name the dataset and the case, and suggest the key MST uses', () => {
    expect(() =>
      buildEvalDataset(
        {
          name: 'search',
          cases: [{ id: 'a', input: 'x', assertions: { regex: ['x'] } }],
        },
        evalConfig
      )
    ).toThrow(
      /Dataset "search" isn't a canonical EvalDataset[\s\S]*case "a" assertions: Unrecognized key: "regex" \(did you mean "matchesPattern"\?\)/
    );
  });
});
