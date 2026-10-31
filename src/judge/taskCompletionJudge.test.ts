import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion } from './judgeClient.js';
import { getJudge, listJudges } from './builtinJudges.js';
import type { JudgeInput } from './judgeContract.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import { TASK_COMPLETION_QUESTION } from './prompts/taskCompletion.js';
import { TASK_COMPLETION_JUDGE } from './taskCompletionJudge.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => vi.mocked(createJudgeCompletion).mockReset());

/** A trace whose only call failed, with an answer that claims success. */
const FALSE_SUCCESS: JudgeInput = {
  case: {
    input: { prompt: 'What is the weather in Oslo?' },
    expected: { answer: '20°C and sunny in Oslo.' },
    tags: [],
    metadata: {},
  },
  trial: {
    response: "It's 20°C and sunny in Oslo.",
    text: "It's 20°C and sunny in Oslo.",
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'get_weather',
        arguments: { location: 'Oslo' },
        output: 'Invalid arguments: city is required',
        isError: true,
      },
    ],
    evidence: 'structured',
  },
};

function model(verdict: string) {
  const requests: JudgeCompletionRequest[] = [];
  vi.mocked(createJudgeCompletion).mockImplementation(() => async (request) => {
    requests.push(request);
    return {
      text: JSON.stringify({ reasoning: 'Event 1 failed.', verdict }),
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

describe('the task-completion judge', () => {
  it('is a built-in judge', () => {
    expect(getJudge('task-completion')).toBe(TASK_COMPLETION_JUDGE);
    expect(listJudges().map(([name]) => name)).toContain('task-completion');
    expect(TASK_COMPLETION_JUDGE.version).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('asks its one question about the trace, with the reference answer', async () => {
    const requests = model('no');
    const score = await TASK_COMPLETION_JUDGE.evaluate(FALSE_SUCCESS, {});
    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain(`Question: ${TASK_COMPLETION_QUESTION}`);
    expect(prompt).toContain('<reference_answer>\n20°C and sunny in Oslo.');
    expect(prompt).toContain('get_weather');
    expect(prompt).toContain('Invalid arguments: city is required');
    expect(score).toMatchObject({ score: 0, reasoning: 'Event 1 failed.' });
    expect(score.unknown).toBeUndefined();
  });

  it('passes on yes, and answers unknown when the model does', async () => {
    model('yes');
    expect(
      await TASK_COMPLETION_JUDGE.evaluate(FALSE_SUCCESS, {})
    ).toMatchObject({ score: 1 });
    model('unknown');
    expect(
      await TASK_COMPLETION_JUDGE.evaluate(FALSE_SUCCESS, {})
    ).toMatchObject({ unknown: true });
  });

  it("answers unknown without a model call when the client didn't report its calls", async () => {
    const requests = model('yes');
    const score = await TASK_COMPLETION_JUDGE.evaluate(
      {
        ...FALSE_SUCCESS,
        trial: { ...FALSE_SUCCESS.trial, events: [], evidence: 'none' },
      },
      {}
    );
    expect(requests).toHaveLength(0);
    expect(score).toMatchObject({ unknown: true });
  });
});
