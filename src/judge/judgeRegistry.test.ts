/**
 * Judge Registry Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { getJudge } from '../evals/frameworkRegistries.js';
import { validateJudge } from '../assertions/validators/judge.js';
import { runEvalDataset } from '../evals/evalRunner.js';
import { validateEvalDataset } from '../evals/datasetTypes.js';
import {
  registerJudge,
  getRegisteredJudge,
  clearJudgeRegistry,
} from './judgeRegistry.js';

beforeEach(() => {
  clearJudgeRegistry();
});

describe('registerJudge', () => {
  it('supports public object registration through the existing framework bridge', () => {
    const judge = {
      name: 'object',
      schema: z.object({}),
      evaluate: async () => ({ score: 1 }),
    };
    registerJudge(judge);
    registerJudge(judge);
    expect(getJudge('object')).toBe(judge);
    expect(getRegisteredJudge('object')).toBe(judge.evaluate);
  });

  it.each(['flat', 'options'])(
    'passes validated %s policy to a judge through dataset evaluation',
    async (style) => {
      const evaluate = vi.fn(
        async (
          _candidate: unknown,
          _reference?: unknown,
          options?: Record<string, unknown>
        ) => ({
          score: options?.policy === 'STRICT' ? 1 : 0,
          reasoning: 'policy applied',
        })
      );
      registerJudge({
        name: 'policy',
        schema: z.object({
          policy: z.string().transform((value) => value.toUpperCase()),
          limit: z.number().default(3),
        }),
        evaluate,
      });
      const policy = { policy: 'strict', ignored: 'stripped' };
      const dataset = validateEvalDataset({
        name: 'judges',
        cases: [
          {
            id: 'one',
            mode: 'host',
            scenario: 'answer',
            expect: {
              passesJudge: {
                judge: 'policy',
                reference: 'reference',
                ...(style === 'flat' ? policy : { options: policy }),
              },
            },
          },
        ],
      });
      const result = await runEvalDataset(
        { dataset, executeCase: async () => ({ response: 'answer' }) },
        {}
      );
      expect(result.passed).toBe(1);
      expect(evaluate).toHaveBeenCalledWith('answer', 'reference', {
        policy: 'STRICT',
        limit: 3,
      });
      expect(result.caseResults[0]?.expectations.judge).toMatchObject({
        score: 1,
        reasoning: 'policy applied',
      });
    }
  );

  it('rejects invalid judge policy before executing', async () => {
    const evaluate = vi.fn(async () => ({ score: 1 }));
    registerJudge({
      name: 'policy',
      schema: z.object({ policy: z.string() }),
      evaluate,
    });
    const result = await validateJudge('answer', {
      judge: 'policy',
      options: { policy: 17 },
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('policy');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('requires a judge schema to return an options object', async () => {
    const evaluate = vi.fn(async () => ({ score: 1 }));
    registerJudge({
      name: 'invalid-schema',
      schema: z.unknown().transform(() => 17),
      evaluate,
    });
    const result = await validateJudge('answer', { judge: 'invalid-schema' });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('options object');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('registers a judge executor by name', () => {
    const executor = async () => ({ score: 1.0, reasoning: 'ok' });
    registerJudge('my-judge', executor);

    expect(getRegisteredJudge('my-judge')).toBe(executor);
  });

  it('is idempotent when re-registering the same function', () => {
    const executor = async () => ({ score: 1.0 });
    registerJudge('dup', executor);
    registerJudge('dup', executor); // should not throw

    expect(getRegisteredJudge('dup')).toBe(executor);
  });

  it('throws when registering a different executor under the same name', () => {
    const executorA = async () => ({ score: 1.0 });
    const executorB = async () => ({ score: 0.0 });
    registerJudge('conflict', executorA);

    expect(() => registerJudge('conflict', executorB)).toThrow(
      'different executor'
    );
  });
});

describe('getRegisteredJudge', () => {
  it('throws with helpful message when judge is not registered', () => {
    expect(() => getRegisteredJudge('nonexistent')).toThrow(
      'Judge "nonexistent" is not registered'
    );
    expect(() => getRegisteredJudge('nonexistent')).toThrow(
      'No judges are registered'
    );
  });

  it('lists available judges in error message', () => {
    registerJudge('alpha', async () => ({ score: 1.0 }));
    registerJudge('beta', async () => ({ score: 1.0 }));

    expect(() => getRegisteredJudge('gamma')).toThrow('alpha, beta');
  });
});

describe('clearJudgeRegistry', () => {
  it('removes all registered judges', () => {
    registerJudge('temp', async () => ({ score: 1.0 }));
    clearJudgeRegistry();

    expect(() => getRegisteredJudge('temp')).toThrow('not registered');
  });

  it('allows re-registration after clearing', () => {
    const executor = async () => ({ score: 1.0 });
    registerJudge('reuse', executor);
    clearJudgeRegistry();
    registerJudge('reuse', executor);

    expect(getRegisteredJudge('reuse')).toBe(executor);
  });
});
