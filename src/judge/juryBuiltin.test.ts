/**
 * A built-in judge as a jury: each member's model is the one called, and
 * the members' answers decide by majority.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion } from './judgeClient.js';
import { evaluateJudge } from './evaluateJudge.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => vi.mocked(createJudgeCompletion).mockReset());

describe('a built-in judge as a jury', () => {
  it('calls each member on its own model and takes the majority', async () => {
    const called: string[] = [];
    vi.mocked(createJudgeCompletion).mockImplementation((config) => {
      const model = config?.model ?? 'default';
      return async () => {
        called.push(model);
        const verdict = model === 'gpt-5-mini' ? 'no' : 'yes';
        return {
          text: JSON.stringify({ reasoning: `${model}: ${verdict}`, verdict }),
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      };
    });
    const result = await evaluateJudge(
      'The port is 7341.',
      {
        judge: 'task-completion',
        options: {},
        label: 'task-completion',
        threshold: 0.5,
        reps: 1,
        jury: [
          { model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5-mini' },
          { model: 'claude-haiku-4-5' },
        ],
      },
      {
        evalCase: { id: 'c', input: 'What port does the service use?' },
        evidence: 'structured',
      }
    );
    expect(called.sort()).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'gpt-5-mini',
    ]);
    expect(result.pass).toBe(true);
    expect(result.details).toMatchObject({
      judgeModel: 'claude-sonnet-4-6, gpt-5-mini, claude-haiku-4-5',
      jury: [
        { model: 'claude-sonnet-4-6', verdict: 'pass' },
        { model: 'gpt-5-mini', provider: 'openai', verdict: 'fail' },
        { model: 'claude-haiku-4-5', verdict: 'pass' },
      ],
    });
  });

  it("names each member's model when none was called", async () => {
    const result = await evaluateJudge(
      'The port is 7341.',
      {
        judge: 'task-completion',
        options: {},
        label: 'task-completion',
        threshold: 0.5,
        reps: 1,
        jury: [{ model: 'claude-sonnet-4-6' }, { model: 'claude-haiku-4-5' }],
      },
      // No reported tool calls: the judge answers unknown without asking.
      { evalCase: { id: 'c', input: 'What port does the service use?' } }
    );
    expect(createJudgeCompletion).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      unknown: true,
      judgeModel: 'claude-sonnet-4-6, claude-haiku-4-5',
      jury: [
        { model: 'claude-sonnet-4-6', verdict: 'unknown' },
        { model: 'claude-haiku-4-5', verdict: 'unknown' },
      ],
    });
  });
});
