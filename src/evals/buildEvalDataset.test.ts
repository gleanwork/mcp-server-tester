import { describe, expect, it } from 'vitest';
import { buildEvalDataset } from './buildEvalDataset.js';
import type { EvalManifest } from './evalManifest.js';

const manifest: EvalManifest = {
  name: 'test',
  datasets: [{ type: 'file', path: 'x.json' }],
};

describe('buildEvalDataset canonical ingestion', () => {
  it('accepts minimal direct cases without mode, args, expectations, or a host', () => {
    const raw = { name: 'canonical', cases: [{ id: 'a', toolName: 'search' }] };
    expect(buildEvalDataset(raw, undefined, manifest).cases).toEqual(raw.cases);
  });

  it('accepts direct request cases, and rejects direct cases with neither target', () => {
    const raw = {
      name: 'canonical',
      cases: [{ id: 'a', request: { method: 'skills/list' } }],
    };
    expect(buildEvalDataset(raw, undefined, manifest).cases).toEqual(raw.cases);
    expect(() =>
      buildEvalDataset(
        { name: 'canonical', cases: [{ id: 'b' }] },
        undefined,
        manifest
      )
    ).toThrow(/toolName or request/);
  });

  it.each([
    { id: 'a', toolName: 'search', args: { query: 'policy' } },
    { id: 'a', mode: 'direct', toolName: 'search', args: {} },
    {
      id: 'a',
      mode: 'host',
      input: 'Find policy',
      client: 'custom-host',
      clientOptions: { option: true },
    },
    {
      id: 'a',
      mode: 'host',
      input: 'Find policy',
    },
  ])('preserves canonical mode and case host override: $mode', (case_) => {
    const dataset = buildEvalDataset(
      {
        name: 'canonical',
        cases: [{ ...case_, trials: 2, passThreshold: 0.75 }],
      },
      { provider: 'anthropic', model: 'manifest-model' },
      { ...manifest, trials: 9, client: 'different-host' }
    );
    expect(dataset.cases[0]).toEqual({
      ...case_,
      trials: 2,
      passThreshold: 0.75,
    });
  });

  it('preserves explicit custom judge assertions without applying manifest policy', () => {
    const case_ = {
      id: 'a',
      toolName: 'search',
      assertions: {
        passesJudge: { judge: 'my-judge', reference: 'answer', threshold: 0.7 },
      },
    };
    expect(
      buildEvalDataset({ name: 'canonical', cases: [case_] }, undefined, {
        ...manifest,
        judges: [{ type: 'another-judge' }],
      }).cases[0]
    ).toEqual(case_);
  });

  it.each([
    { id: 'a', input: 'find policy', expected_tool: 'search' },
    { id: 'a', tool: 'search', assertions: { isError: false } },
    {
      id: 'a',
      mode: 'host',
      input: 'find policy',
      expected_tool: 'search',
    },
    { id: 'a', toolName: 'search', tool: 'other' },
  ])('rejects legacy inputs clearly without a source adapter: $id', (case_) => {
    expect(() =>
      buildEvalDataset({ name: 'legacy', cases: [case_] }, undefined, manifest)
    ).toThrow(/canonical EvalDataset.*explicit dataset source adapter/);
  });

  it('reads a case with input as a client case', () => {
    expect(
      buildEvalDataset(
        { name: 'question', cases: [{ id: 'a', input: 'find policy' }] },
        undefined,
        manifest
      ).cases
    ).toEqual([{ id: 'a', input: 'find policy' }]);
  });

  it('validates every case, even after maxCases and a canonical first case', () => {
    expect(() =>
      buildEvalDataset(
        {
          name: 'mixed',
          cases: [
            { id: 'good', toolName: 'search' },
            {
              id: 'legacy',
              mode: 'host',
              input: 'Find policy',
              expected_tool: 'search',
            },
          ],
        },
        undefined,
        { ...manifest, maxCases: 1 }
      )
    ).toThrow(/expected_tool/);
  });

  it('reports invalid canonical cases and empty datasets', () => {
    expect(() =>
      buildEvalDataset(
        { name: 'bad', cases: [{ id: 'a', toolName: 123 }] },
        undefined,
        manifest
      )
    ).toThrow(/toolName/);
    expect(() =>
      buildEvalDataset({ name: 'empty', cases: [] }, undefined, manifest)
    ).toThrow(/at least one case/);
  });

  it('applies tag selection before nested run.maxCases without changing source data', () => {
    const raw = {
      name: 'tagged',
      cases: [
        { id: 'skip', toolName: 'search', tags: ['other'] },
        { id: 'keep', toolName: 'search', tags: ['wanted'] },
        { id: 'limit', toolName: 'search', tags: ['wanted'] },
      ],
    };
    expect(
      buildEvalDataset(raw, undefined, {
        ...manifest,
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
            { id: 'a', toolName: 'search' },
            { id: 'b', toolName: 'search' },
          ],
        },
        undefined,
        { ...manifest, maxCases: 1 }
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
          cases: [
            { id: 'a', toolName: 't', args: {}, assertions: { regex: ['x'] } },
          ],
        },
        undefined,
        manifest
      )
    ).toThrow(
      /Dataset "search" isn't a canonical EvalDataset[\s\S]*case "a" assertions: Unrecognized key: "regex" \(did you mean "matchesPattern"\?\)/
    );
  });
});
