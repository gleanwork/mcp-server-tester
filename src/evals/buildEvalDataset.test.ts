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

  it.each([
    { id: 'a', toolName: 'search', args: { query: 'policy' } },
    { id: 'a', mode: 'direct', toolName: 'search', args: {} },
    {
      id: 'a',
      mode: 'host',
      scenario: 'Find policy',
      host: { type: 'custom-host', option: true },
    },
    {
      id: 'a',
      mode: 'mcp_host',
      scenario: 'Find policy',
      mcpHostConfig: { provider: 'openai', model: 'case-model' },
    },
    {
      id: 'a',
      mode: 'external_host',
      scenario: 'Find policy',
      externalHost: { driver: 'custom-driver' },
    },
  ])('preserves canonical mode and case host override: $mode', (case_) => {
    const dataset = buildEvalDataset(
      {
        name: 'canonical',
        cases: [{ ...case_, iterations: 2, accuracyThreshold: 0.75 }],
      },
      { provider: 'anthropic', model: 'manifest-model' },
      { ...manifest, iterations: 9, host: { type: 'different-host' } }
    );
    expect(dataset.cases[0]).toEqual({
      ...case_,
      iterations: 2,
      accuracyThreshold: 0.75,
    });
  });

  it('preserves explicit custom judge assertions without applying manifest policy', () => {
    const case_ = {
      id: 'a',
      toolName: 'search',
      expect: {
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
    { id: 'a', scenario: 'find policy', expected_tool: 'search' },
    { id: 'a', tool: 'search', expect: { isError: false } },
    { id: 'a', scenario: 'find policy' },
    {
      id: 'a',
      mode: 'mcp_host',
      scenario: 'find policy',
      expected_tool: 'search',
    },
    { id: 'a', toolName: 'search', tool: 'other' },
  ])('rejects legacy inputs clearly without a source adapter: $id', (case_) => {
    expect(() =>
      buildEvalDataset({ name: 'legacy', cases: [case_] }, undefined, manifest)
    ).toThrow(/canonical EvalDataset.*explicit dataset source adapter/);
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
              scenario: 'Find policy',
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
