import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostRunToExecution } from './hostTrace.js';
import { runEvalCase, runEvalDataset } from './evalRunner.js';
import type { CaseExecution } from './caseExecution.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('pre-executed iteration timing', () => {
  it('adds known pre-execution time once per iteration without changing dataset wall time', async () => {
    const durations = [10, 20, undefined, 40];
    const executeCase = vi.fn(async (): Promise<CaseExecution> => {
      advance(3);
      return {
        ...hostRunToExecution({ finalText: 'OK', events: [] }, 'structured'),
        preExecutionDurationMs: durations.shift(),
      };
    });
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'timing',
          cases: [
            { id: 'a', input: 'A', trials: 2 },
            { id: 'b', input: 'B', trials: 2 },
          ],
        },
        executeCase,
      },
      {}
    );

    expect(executeCase).toHaveBeenCalledTimes(4);
    expect(result.caseResults.map((c) => c.durationMs)).toEqual([36, 46]);
    expect(
      result.caseResults.map((c) =>
        c.iterationResults?.map((iteration) => iteration.durationMs)
      )
    ).toEqual([
      [13, 23],
      [3, 43],
    ]);
    expect(result.durationMs).toBe(12);
  });

  it.each([undefined, 0, 25])(
    'preserves failed-case timing with pre-execution time %s',
    async (duration) => {
      const result = await runEvalCase(
        { id: 'failed', input: 'A' },
        {},
        {
          async executeCase() {
            advance(5);
            return {
              kind: 'failed',
              response: undefined,
              error: 'Failed',
              preExecutionDurationMs: duration,
            };
          },
        }
      );

      expect(result.pass).toBe(false);
      expect(result.durationMs).toBe(5 + (duration ?? 0));
    }
  );

  it('measures ordinary live execution without a pre-execution duration', async () => {
    const result = await runEvalCase(
      { id: 'live', input: 'A', trials: 2 },
      {},
      {
        async executeCase() {
          advance(25);
          return hostRunToExecution(
            { finalText: 'OK', events: [] },
            'structured'
          );
        },
      }
    );

    expect(result.durationMs).toBe(50);
    expect(result.iterationResults?.map((r) => r.durationMs)).toEqual([25, 25]);
  });
});
