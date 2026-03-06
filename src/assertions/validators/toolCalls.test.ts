import { describe, it, expect } from 'vitest';
import { validateToolCalls, validateToolCallCount } from './toolCalls.js';
import type { MCPHostSimulationResult } from '../../evals/mcpHost/mcpHostTypes.js';

function makeResult(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
): MCPHostSimulationResult {
  return {
    success: true,
    toolCalls: toolCalls.map((c) => ({ ...c, arguments: c.arguments ?? {} })),
  };
}

describe('validateToolCalls', () => {
  it('passes when required tool was called', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when required tool was not called', () => {
    const result = makeResult([{ name: 'other' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: true }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('search');
  });

  it('passes optional tool even when missing', () => {
    const result = makeResult([]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', required: false }],
    });
    expect(v.pass).toBe(true);
  });

  it('validates partial argument match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'hello', limit: 10 } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(true);
  });

  it('fails when arguments do not match', () => {
    const result = makeResult([
      { name: 'search', arguments: { query: 'wrong' } },
    ]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { query: 'hello' } }],
    });
    expect(v.pass).toBe(false);
  });

  it('argument matching is not sensitive to key declaration order', () => {
    // actual call has keys in { a, b } order; expected spec declares them as { b, a }
    // partialMatch recurses into nested objects so key order never reaches JSON.stringify
    const result = makeResult([{ name: 'search', arguments: { a: 1, b: 2 } }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search', arguments: { b: 2, a: 1 } }],
    });
    expect(v.pass).toBe(true);
  });

  it('enforces strict order when order is strict', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'fetch' }, { name: 'search' }],
      order: 'strict',
    });
    expect(v.pass).toBe(false);
  });

  it('passes strict order when sequence matches', () => {
    const result = makeResult([{ name: 'search' }, { name: 'fetch' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }, { name: 'fetch' }],
      order: 'strict',
    });
    expect(v.pass).toBe(true);
  });

  it('fails when exclusive and unexpected tool was called', () => {
    const result = makeResult([{ name: 'search' }, { name: 'unexpected' }]);
    const v = validateToolCalls(result, {
      calls: [{ name: 'search' }],
      exclusive: true,
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('unexpected');
  });

  it('returns error when response is not an MCPHostSimulationResult', () => {
    const v = validateToolCalls('not a simulation result', {
      calls: [{ name: 'search' }],
    });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('mcp_host');
  });
});

describe('validateToolCalls precision and recall metrics', () => {
  const makeResult = (toolNames: string[]) => ({
    success: true,
    toolCalls: toolNames.map((name) => ({ name, arguments: {} })),
    response: 'done',
  });

  it('recall is 1.0 when all required tools were called', () => {
    const result = validateToolCalls(makeResult(['search', 'read']), {
      calls: [
        { name: 'search', required: true },
        { name: 'read', required: true },
      ],
    });
    expect(result.metrics?.recall).toBe(1.0);
  });

  it('recall is 0.5 when one of two required tools was missed', () => {
    const result = validateToolCalls(makeResult(['search']), {
      calls: [
        { name: 'search', required: true },
        { name: 'read', required: true },
      ],
    });
    expect(result.metrics?.recall).toBe(0.5);
  });

  it('recall is 1.0 when no required calls defined', () => {
    const result = validateToolCalls(makeResult([]), {
      calls: [],
    });
    expect(result.metrics?.recall).toBe(1.0);
  });

  it('precision reflects actual tool call efficiency even when exclusive is false (default)', () => {
    const result = validateToolCalls(makeResult(['search', 'unexpected']), {
      calls: [{ name: 'search', required: true }],
      exclusive: false,
    });
    // 1 of 2 actual calls matched an expected call → precision = 0.5
    // The case still passes (exclusive=false means no failure on unexpected calls)
    expect(result.pass).toBe(true);
    expect(result.metrics?.precision).toBe(0.5);
  });

  it('precision is 0.5 when exclusive is true and half of calls were unexpected', () => {
    const result = validateToolCalls(makeResult(['search', 'unexpected']), {
      calls: [{ name: 'search', required: true }],
      exclusive: true,
    });
    expect(result.metrics?.precision).toBe(0.5);
  });

  it('precision is 1.0 when exclusive is true and all calls were expected', () => {
    const result = validateToolCalls(makeResult(['search']), {
      calls: [{ name: 'search', required: true }],
      exclusive: true,
    });
    expect(result.metrics?.precision).toBe(1.0);
  });

  it('attaches metrics even on failure', () => {
    const result = validateToolCalls(makeResult([]), {
      calls: [{ name: 'search', required: true }],
    });
    expect(result.pass).toBe(false);
    expect(result.metrics?.recall).toBe(0.0);
  });
});

describe('validateToolCallCount', () => {
  it('passes exact count', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { exact: 2 }).pass).toBe(true);
  });

  it('fails wrong exact count', () => {
    const result = makeResult([{ name: 'a' }]);
    const v = validateToolCallCount(result, { exact: 2 });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('1');
  });

  it('passes min/max range', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }]);
    expect(validateToolCallCount(result, { min: 1, max: 3 }).pass).toBe(true);
  });

  it('fails when below min', () => {
    const result = makeResult([]);
    expect(validateToolCallCount(result, { min: 1 }).pass).toBe(false);
  });

  it('fails when above max', () => {
    const result = makeResult([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(validateToolCallCount(result, { max: 2 }).pass).toBe(false);
  });

  it('returns error when response is not an MCPHostSimulationResult', () => {
    const v = validateToolCallCount('not a simulation result', { exact: 1 });
    expect(v.pass).toBe(false);
    expect(v.message).toContain('mcp_host');
  });
});
