import { describe, it, expect } from 'vitest';
import {
  EvalConfigSchema,
  loadEvalConfigFromObject,
  resolveEvalsetPaths,
} from './evalConfigSchema.js';

describe('EvalConfigSchema', () => {
  it('parses a minimal evaluation config', () => {
    const config = EvalConfigSchema.parse({
      name: 'code-search',
      mode: 'direct',
      evalsetFilePaths: ['evalsets/code-search.json'],
    });

    expect(config.name).toBe('code-search');
    expect(config.mode).toBe('direct');
  });

  it('accepts plugin references', () => {
    const config = EvalConfigSchema.parse({
      name: 'with-plugin',
      mode: 'e2e-quality',
      plugins: [{ name: 'custom-judge', dir: './plugins/custom-judge' }],
    });

    expect(config.plugins?.[0]?.name).toBe('custom-judge');
  });
});

describe('resolveEvalsetPaths', () => {
  it('resolves relative paths against rootDir', () => {
    const paths = resolveEvalsetPaths(
      {
        name: 'x',
        mode: 'direct',
        evalsetFilePaths: ['evalsets/search.json'],
      },
      '/tmp/mcp_tests'
    );

    expect(paths).toEqual(['/tmp/mcp_tests/evalsets/search.json']);
  });

  it('falls back to localEvalsets', () => {
    const paths = resolveEvalsetPaths(
      {
        name: 'x',
        mode: 'direct',
        localEvalsets: 'fixtures/evals/search-evals.json',
      },
      '/tmp/mcp_tests'
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
          mode: 'direct',
          evalsetFilePaths: ['does-not-exist.json'],
        },
        { rootDir: process.cwd() }
      )
    ).toThrow(/Evalset path not found/);
  });
});
