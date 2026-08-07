import { describe, expect, it } from 'vitest';
import { buildEvalDataset } from './buildEvalDataset.js';
import type { EvalConfig } from './evalConfigSchema.js';
import { getBuiltinHostConfig } from './builtinHosts.js';

const baseConfig: EvalConfig = {
  name: 'test',
  mode: 'tool-selection',
  evalsetFilePaths: ['x.json'],
};

const hostConfig = getBuiltinHostConfig('vercel-sdk');

describe('buildEvalDataset', () => {
  it('builds tool-selection dataset from raw evalset', () => {
    const dataset = buildEvalDataset(
      {
        name: 'search',
        cases: [
          {
            id: 'case-1',
            scenario: 'find the PTO policy',
            expected_tool: 'search',
          },
        ],
      },
      'tool-selection',
      hostConfig,
      baseConfig,
    );

    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]?.mode).toBe('mcp_host');
    expect(dataset.cases[0]?.expect?.toolsTriggered?.calls[0]?.name).toBe(
      'search',
    );
    expect(dataset.cases[0]?.tags).toContain('tool_selection');
  });

  it('builds e2e-quality dataset with judges from config', () => {
    const dataset = buildEvalDataset(
      {
        name: 'info-seeking',
        cases: [
          {
            id: 'q1',
            scenario: 'What is our parental leave policy?',
            reference: '12 weeks paid leave',
          },
        ],
      },
      'e2e-quality',
      hostConfig,
      {
        ...baseConfig,
        mode: 'e2e-quality',
        judges: ['glean-completeness', 'glean-correctness'],
      },
    );

    expect(dataset.cases[0]?.tags).toContain('e2e_quality');
    const judges = dataset.cases[0]?.expect?.passesJudge;
    expect(Array.isArray(judges)).toBe(true);
    expect(judges).toHaveLength(2);
  });

  it('passes through prebuilt datasets unchanged', () => {
    const prebuilt = {
      name: 'search-evals',
      cases: [
        {
          id: 'search-basic',
          toolName: 'search',
          args: { query: 'pto policy' },
          expect: { isError: false },
        },
      ],
    };

    const dataset = buildEvalDataset(
      prebuilt,
      'direct',
      hostConfig,
      { ...baseConfig, mode: 'direct' },
    );

    expect(dataset.cases[0]?.toolName).toBe('search');
    expect(dataset.cases[0]?.args).toEqual({ query: 'pto policy' });
  });

  it('truncates to maxCases', () => {
    const dataset = buildEvalDataset(
      {
        cases: [
          { id: 'a', scenario: 'one', expected_tool: 'search' },
          { id: 'b', scenario: 'two', expected_tool: 'search' },
        ],
      },
      'tool-selection',
      hostConfig,
      { ...baseConfig, maxCases: 1 },
    );

    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]?.id).toBe('a');
  });
});
