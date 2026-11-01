/**
 * Juries (ADR 0009): one judge on several models, decided by the members'
 * majority, with an identity that is the set of the members' identities.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { judgeIdentityOf } from '../assertions/validators/judge.js';
import {
  evaluateJudge,
  judgeRequestIdentity,
  preflightJudgeRequest,
  type JudgeRequest,
} from './evaluateJudge.js';
import type { JudgeScore } from './judgeContract.js';

afterEach(() => resetPluginsForTests());

/** What each model answers: a verdict, or an error it throws. */
type Answer = 'pass' | 'fail' | 'unknown' | 'skip' | 'throw';

/** A judge that answers by the `model` in its options. */
function install(answers: Record<string, Answer>, criteria = false): void {
  resetPluginsForTests();
  installPlugins([
    {
      meta: { name: 'jury-plugin', namespace: 'acme' },
      judges: {
        votes: {
          version: '1',
          schema: z.object({ model: z.string() }).strict(),
          async evaluate(_input, options): Promise<JudgeScore> {
            const model = (options as { model: string }).model;
            const answer = answers[model] ?? 'pass';
            if (answer === 'throw') throw new Error('rate limited');
            const base = {
              model,
              provider: 'test',
              usage: { inputTokens: 10, outputTokens: 1 },
            };
            if (answer === 'skip')
              return { ...base, score: 0, skipped: true, reasoning: 'n/a' };
            if (answer === 'unknown')
              return { ...base, score: 0, unknown: true, reasoning: 'unsure' };
            const pass = answer === 'pass';
            return {
              ...base,
              score: pass ? 1 : 0,
              pass,
              reasoning: `${model} says ${answer}`,
              ...(criteria
                ? {
                    criteria: [
                      { id: 'cites', verdict: answer, reasoning: model },
                    ],
                  }
                : {}),
            };
          },
        },
      },
    },
  ]);
}

function request(models: string[], extra: Partial<JudgeRequest> = {}) {
  return {
    judge: 'acme/judge/votes',
    options: {},
    label: 'acme/judge/votes',
    threshold: 0.5,
    reps: 1,
    jury: models.map((model) => ({ model })),
    ...extra,
  } satisfies JudgeRequest;
}

async function grade(models: string[], extra: Partial<JudgeRequest> = {}) {
  const result = await evaluateJudge('answer', request(models, extra));
  return { pass: result.pass, message: result.message, ...result.details };
}

describe('a jury', () => {
  it('passes or fails by the majority of its members, and records each vote', async () => {
    install({ a: 'pass', b: 'fail', c: 'pass' });
    const passed = await grade(['a', 'b', 'c']);
    expect(passed).toMatchObject({
      pass: true,
      score: expect.closeTo(2 / 3, 9),
      judgeModel: 'a, b, c',
      reasoning: 'a says pass',
      usage: { inputTokens: 30, outputTokens: 3 },
      jury: [
        { model: 'a', provider: 'test', verdict: 'pass', score: 1 },
        { model: 'b', verdict: 'fail', score: 0 },
        { model: 'c', verdict: 'pass' },
      ],
    });
    expect(passed.message).toContain('2 of 3 jury members passed it');
    install({ a: 'fail', b: 'fail', c: 'pass' });
    expect(await grade(['a', 'b', 'c'])).toMatchObject({
      pass: false,
      reasoning: 'a says fail',
    });
  });

  it('is unknown on a tie, and counts only members that decided', async () => {
    install({ a: 'pass', b: 'fail' });
    const tied = await grade(['a', 'b']);
    expect(tied).toMatchObject({ pass: false, unknown: true });
    expect(tied).not.toHaveProperty('score');
    expect(tied.message).toContain('answered unknown');
    // One unknown member doesn't block the other two.
    install({ a: 'pass', b: 'unknown', c: 'pass' });
    expect(await grade(['a', 'b', 'c'])).toMatchObject({
      pass: true,
      score: 1,
    });
    install({ a: 'unknown', b: 'unknown' });
    expect(await grade(['a', 'b'])).toMatchObject({ unknown: true });
  });

  it('skips only when every member skips, and leaves skipping members out', async () => {
    install({ a: 'skip', b: 'skip' });
    expect(await grade(['a', 'b'])).toMatchObject({
      skipped: true,
      jury: [{ verdict: 'skipped' }, { verdict: 'skipped' }],
    });
    install({ a: 'skip', b: 'fail' });
    expect(await grade(['a', 'b'])).toMatchObject({ pass: false, score: 0 });
  });

  it('fails to score when a member fails to run, naming it', async () => {
    install({ a: 'pass', b: 'throw' });
    const result = await grade(['a', 'b']);
    expect(result.error).toBeDefined();
    expect(result.message).toContain('jury member 2');
    expect(result.message).toContain('rate limited');
  });

  it('takes each criterion by the majority too, with a jury identity', async () => {
    install({ a: 'pass', b: 'fail', c: 'fail' }, true);
    const result = await grade(['a', 'b', 'c']);
    const [criterion] = result.criteria as Array<Record<string, unknown>>;
    expect(criterion).toMatchObject({ id: 'cites', verdict: 'fail' });
    expect(criterion!.judgeIdentity).toMatch(/^[0-9a-f]{64}$/);
    install({ a: 'pass', b: 'fail' }, true);
    const tied = await grade(['a', 'b']);
    expect(tied.criteria).toMatchObject([{ id: 'cites', verdict: 'unknown' }]);
  });

  it("has an identity that is its members', in any order", async () => {
    install({});
    const ab = judgeRequestIdentity(request(['a', 'b'])).judgeIdentity;
    expect(judgeRequestIdentity(request(['b', 'a'])).judgeIdentity).toBe(ab);
    expect(judgeRequestIdentity(request(['a', 'c'])).judgeIdentity).not.toBe(
      ab
    );
    expect(ab).not.toBe(
      judgeRequestIdentity({
        ...request(['a']),
        jury: undefined,
        options: { model: 'a' },
      }).judgeIdentity
    );
    // Grading policy reaches every member.
    expect(
      judgeRequestIdentity(request(['a', 'b'], { threshold: 0.9 }))
        .judgeIdentity
    ).not.toBe(ab);
    expect((await grade(['a', 'b'])).judgeIdentity).toBe(ab);
    // A case or eval config judge records the same identity.
    expect(
      judgeIdentityOf({
        judge: 'acme/judge/votes',
        threshold: 0.5,
        jury: [{ model: 'a' }, { model: 'b' }],
      })
    ).toBe(ab);
  });

  it('rejects a jury of one, the same member twice, or a member setting grading keys', async () => {
    install({});
    for (const jury of [
      [{ model: 'a' }],
      [{ model: 'a' }, { model: 'a' }],
      [{ model: 'a' }, { model: 'b', reps: 3 }],
    ]) {
      const result = await grade([], { jury });
      expect(result.error).toBeDefined();
      await expect(
        preflightJudgeRequest({ ...request([]), jury })
      ).rejects.toThrow(/can't run/);
    }
  });

  it('checks each member at preflight', async () => {
    install({});
    await expect(
      preflightJudgeRequest(request(['a', 'b']))
    ).resolves.toBeUndefined();
    await expect(
      preflightJudgeRequest({
        ...request([]),
        jury: [{ model: 'a' }, { model: 'b', colour: 'red' }],
      })
    ).rejects.toThrow(/can't run/);
  });
});
