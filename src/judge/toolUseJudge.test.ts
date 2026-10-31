import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion } from './judgeClient.js';
import { getJudge, listJudges } from './builtinJudges.js';
import { BUILT_IN_JUDGE_QUESTIONS } from './builtinQuestions.js';
import type { JudgeInput } from './judgeContract.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import {
  ERROR_RECOVERY_QUESTION,
  NEEDED_CALLS_QUESTION,
  TOOL_ARGUMENTS_QUESTION,
  TOOL_CHOICE_QUESTION,
  TOOL_USE_LABEL_QUESTION,
  TOOL_USE_QUESTIONS,
} from './prompts/toolUse.js';
import { TOOL_USE_JUDGE } from './toolUseJudge.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => vi.mocked(createJudgeCompletion).mockReset());

/** A call with a wrong argument, and an answer that gives up. */
const GAVE_UP: JudgeInput = {
  case: {
    input: { prompt: 'What is the weather in Oslo?' },
    expected: { answer: '20°C and sunny in Oslo.' },
    tags: [],
    metadata: {},
  },
  trial: {
    response: "The weather tool returned an error, so I can't tell you.",
    text: "The weather tool returned an error, so I can't tell you.",
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

/** A model that answers each question by the first line of its text. */
function model(verdicts: Partial<Record<string, string>>) {
  const requests: JudgeCompletionRequest[] = [];
  vi.mocked(createJudgeCompletion).mockImplementation(() => async (request) => {
    requests.push(request);
    const id = Object.entries(TOOL_USE_QUESTIONS).find(([, text]) =>
      request.prompt.includes(text)
    )?.[0];
    return {
      text: JSON.stringify({
        reasoning: `${id} reasoning`,
        verdict: verdicts[id ?? ''] ?? 'yes',
      }),
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

function rules(question: string) {
  const parts = question.split('\n\n');
  return (start: string) => parts.find((p) => p.startsWith(start))!;
}

describe('the tool-use judge', () => {
  it('is a built-in judge, and the label page shows all four questions', () => {
    expect(getJudge('tool-use')).toBe(TOOL_USE_JUDGE);
    expect(listJudges().map(([name]) => name)).toContain('tool-use');
    expect(TOOL_USE_JUDGE.version).toMatch(/^[0-9a-f]{16,}$/);
    expect(BUILT_IN_JUDGE_QUESTIONS['tool-use']).toBe(TOOL_USE_LABEL_QUESTION);
    expect(TOOL_USE_LABEL_QUESTION).toContain('Fail the trial if');
    for (const text of Object.values(TOOL_USE_QUESTIONS))
      expect(TOOL_USE_LABEL_QUESTION).toContain(text);
  });

  it('asks the rules ADR 0009 gives the judge, each in its own question', () => {
    // These pin each question's rules on their own: a change to one of
    // them should change this test, not only the prompt file.
    const choice = rules(TOOL_CHOICE_QUESTION);
    expect(choice('Answer "yes"')).toContain('the request needed no tool');
    expect(choice('Answer "no"')).toContain('needed a tool and called none');
    expect(choice('Leave')).toContain('wrong arguments is "yes" here');

    const args = rules(TOOL_ARGUMENTS_QUESTION);
    expect(args('Answer "yes"')).toContain('ones its tool accepts');
    expect(args('Answer "yes"')).toContain('ask for what the user asked');
    expect(args('Answer "no"')).toContain('no later call corrects');
    expect(args('A mistake')).toContain('a later call corrects is "yes"');

    const needed = rules(NEEDED_CALLS_QUESTION);
    expect(needed('Answer "yes"')).toContain('to find the way after an error');
    expect(needed('Answer "no"')).toContain('the same call again');
    expect(needed('Leave')).toContain('the wrong tool is "yes" here');

    const recovery = rules(ERROR_RECOVERY_QUESTION);
    expect(recovery('Answer "yes"')).toContain('no call failed');
    expect(recovery('Answer "yes"')).toContain("couldn't fix");
    expect(recovery('Answer "no"')).toContain("the assistant's own mistake");
    expect(recovery('Answer "no"')).toContain('as if the call had worked');
  });

  it('asks each question in its own call, without the reference answer', async () => {
    const requests = model({});
    const score = await TOOL_USE_JUDGE.evaluate(GAVE_UP, {});
    expect(requests).toHaveLength(4);
    for (const [i, text] of Object.values(TOOL_USE_QUESTIONS).entries()) {
      const prompt = requests[i]!.prompt;
      expect(prompt).toContain(`Question: ${text}`);
      expect(prompt).toContain('Invalid arguments: city is required');
      expect(prompt).not.toContain('<reference_answer>');
    }
    expect(score).toMatchObject({ score: 1, pass: true });
    expect(Object.keys(score.subScores ?? {})).toEqual(
      Object.keys(TOOL_USE_QUESTIONS)
    );
  });

  it('fails when any answer is no, and names the question', async () => {
    model({ arguments: 'no', 'error-recovery': 'no' });
    const score = await TOOL_USE_JUDGE.evaluate(GAVE_UP, {});
    expect(score).toMatchObject({ score: 0, pass: false });
    expect(score.reasoning).toBe(
      'arguments: arguments reasoning\nerror-recovery: error-recovery reasoning'
    );
    expect(score.subScores?.['tool-choice']).toMatchObject({ pass: true });
    expect(score.subScores?.arguments).toMatchObject({ pass: false });
  });

  it('answers unknown when no answer is no and one is unknown', async () => {
    model({ 'needed-calls': 'unknown' });
    expect(await TOOL_USE_JUDGE.evaluate(GAVE_UP, {})).toMatchObject({
      unknown: true,
    });
    model({ 'needed-calls': 'unknown', 'tool-choice': 'no' });
    expect(await TOOL_USE_JUDGE.evaluate(GAVE_UP, {})).toMatchObject({
      score: 0,
      pass: false,
    });
  });

  it("answers unknown without a model call when the client didn't report its calls", async () => {
    const requests = model({});
    const score = await TOOL_USE_JUDGE.evaluate(
      { ...GAVE_UP, trial: { ...GAVE_UP.trial, events: [], evidence: 'none' } },
      {}
    );
    expect(requests).toHaveLength(0);
    expect(score).toMatchObject({ unknown: true });
  });
});
