import { describe, it, expect as vitestExpect } from 'vitest';
import { expect as mcpExpect } from './index.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

function makeResult(names: string[]): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: names.map((name) => ({ name, arguments: {} })),
  };
}

describe('toHaveToolCalls', () => {
  it('passes when required tool was called', () => {
    const result = makeResult(['search', 'fetch']);
    vitestExpect(() =>
      mcpExpect(result).toHaveToolCalls({ calls: [{ name: 'search' }] })
    ).not.toThrow();
  });

  it('fails when required tool was not called', () => {
    const result = makeResult(['fetch']);
    vitestExpect(() =>
      mcpExpect(result).toHaveToolCalls({ calls: [{ name: 'search' }] })
    ).toThrow();
  });

  it('supports negation with not', () => {
    const result = makeResult(['search']);
    vitestExpect(() =>
      mcpExpect(result).not.toHaveToolCalls({ calls: [{ name: 'other' }] })
    ).not.toThrow();
  });
});

describe('toHaveToolCallCount', () => {
  it('passes with exact count', () => {
    const result = makeResult(['a', 'b']);
    vitestExpect(() =>
      mcpExpect(result).toHaveToolCallCount({ exact: 2 })
    ).not.toThrow();
  });

  it('fails with wrong count', () => {
    const result = makeResult(['a']);
    vitestExpect(() =>
      mcpExpect(result).toHaveToolCallCount({ exact: 2 })
    ).toThrow();
  });

  it('passes min/max range', () => {
    const result = makeResult(['a', 'b']);
    vitestExpect(() =>
      mcpExpect(result).toHaveToolCallCount({ min: 1, max: 3 })
    ).not.toThrow();
  });
});
