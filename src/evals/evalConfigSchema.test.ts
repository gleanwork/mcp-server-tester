import { describe, it, expect } from 'vitest';
import {
  EvalConfigSchema,
  loadEvalConfigFromObject,
  resolveEvalModeConfig,
  resolveEvalsetPaths,
} from './evalConfigSchema.js';

describe('EvalConfigSchema', () => {
  it('parses a tool-selection weekly config', () => {
    const config = EvalConfigSchema.parse({
      name: 'weekly-tool-selection-search',
      mode: 'tool-selection',
      evalsetFilePaths: ['evalsets/tool-selection/search.json'],
      model: 'claude-sonnet-4-6',
      clientHost: 'claude-cli',
      mcpUrl: 'https://scio-prod-be.glean.com/mcp/default/eval',
      concurrency: 5,
      maxCases: 50,
      metrics: ['passed', 'cost_usd'],
    });

    expect(config.name).toBe('weekly-tool-selection-search');
    expect(config.mode).toBe('tool-selection');
  });

  it('requires serverB for sxs mode', () => {
    const result = EvalConfigSchema.safeParse({
      name: 'sxs-run',
      mode: 'sxs',
      evalsetFilePaths: ['evalsets/tool-selection/search.json'],
    });

    expect(result.success).toBe(false);
  });

  it('accepts metric objects with params', () => {
    const config = EvalConfigSchema.parse({
      name: 'e2e',
      mode: 'e2e-quality',
      evalsetFilePaths: ['evalsets/e2e-quality/info-seeking.json'],
      judges: ['glean-completeness'],
      metrics: [
        {
          metric: 'judge_pass_for',
          name: 'judge_glean_completeness_pass',
          params: { judge: 'glean-completeness' },
        },
      ],
    });

    expect(config.metrics?.[0]).toEqual({
      metric: 'judge_pass_for',
      name: 'judge_glean_completeness_pass',
      params: { judge: 'glean-completeness' },
    });
  });
});

describe('resolveEvalModeConfig', () => {
  it('maps tool-selection to mcp_host tag filter', () => {
    expect(resolveEvalModeConfig('tool-selection')).toEqual({
      filterTags: ['mcp_host'],
      requiresJudges: false,
      isServerComparison: false,
    });
  });

  it('maps e2e-quality to e2e_quality tag filter with judges', () => {
    expect(resolveEvalModeConfig('e2e-quality')).toEqual({
      filterTags: ['e2e_quality'],
      requiresJudges: true,
      isServerComparison: false,
    });
  });
});

describe('resolveEvalsetPaths', () => {
  it('resolves relative paths against rootDir', () => {
    const paths = resolveEvalsetPaths(
      {
        name: 'x',
        mode: 'tool-selection',
        evalsetFilePaths: ['evalsets/search.json'],
      },
      '/tmp/mcp_tests',
    );

    expect(paths).toEqual(['/tmp/mcp_tests/evalsets/search.json']);
  });

  it('falls back to localEvalsets', () => {
    const paths = resolveEvalsetPaths(
      {
        name: 'x',
        mode: 'tool-selection',
        localEvalsets: 'fixtures/evals/search-evals.json',
      },
      '/tmp/mcp_tests',
    );

    expect(paths).toEqual(['/tmp/mcp_tests/fixtures/evals/search-evals.json']);
  });
});

describe('loadEvalConfigFromObject', () => {
  it('validates evalset paths exist', () => {
    expect(() =>
      loadEvalConfigFromObject(
        {
          name: 'missing',
          mode: 'tool-selection',
          evalsetFilePaths: ['does-not-exist.json'],
        },
        { rootDir: process.cwd() },
      ),
    ).toThrow(/Evalset path not found/);
  });
});
