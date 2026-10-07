/**
 * The built-in rubric judge reads the run and the reference from the judge
 * input, and reports the LLM client's usage.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./judgeClient.js', () => ({ createJudge: vi.fn() }));

import { createJudge } from './judgeClient.js';
import { RUBRIC_JUDGE } from './rubricJudge.js';
import { buildJudgeCase, buildJudgeTrial } from './judgeContract.js';

describe('RUBRIC_JUDGE', () => {
  it('grades trial.response against case.expected.answer and reports usage', async () => {
    const usage = { inputTokens: 40, outputTokens: 5, durationMs: 9 };
    const evaluate = vi
      .fn()
      .mockResolvedValue({ pass: true, score: 0.8, reasoning: 'ok', usage });
    vi.mocked(createJudge).mockReturnValue({ evaluate });

    const score = await RUBRIC_JUDGE.evaluate(
      {
        case: buildJudgeCase({ expected: { answer: 'gold' } }),
        trial: buildJudgeTrial('answer'),
      },
      { rubric: 'correctness' }
    );

    expect(evaluate).toHaveBeenCalledWith(
      'answer',
      'gold',
      expect.stringContaining('factually correct')
    );
    expect(score).toMatchObject({ score: 0.8, reasoning: 'ok', usage });
  });

  it('passes a null reference when the case has no answer', async () => {
    const evaluate = vi.fn().mockResolvedValue({ pass: false, score: 0 });
    vi.mocked(createJudge).mockReturnValue({ evaluate });
    await RUBRIC_JUDGE.evaluate(
      { case: buildJudgeCase(undefined), trial: buildJudgeTrial('answer') },
      { rubric: 'correctness' }
    );
    expect(evaluate.mock.calls[0]![1]).toBeNull();
  });
});
