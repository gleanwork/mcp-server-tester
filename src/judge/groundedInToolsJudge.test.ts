import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion } from './judgeClient.js';
import { getJudge, listJudges } from './builtinJudges.js';
import { BUILT_IN_JUDGE_QUESTIONS } from './builtinQuestions.js';
import { GROUNDED_IN_TOOLS_JUDGE } from './groundedInToolsJudge.js';
import type { JudgeInput } from './judgeContract.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import { GROUNDED_IN_TOOLS_QUESTION } from './prompts/groundedInTools.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => vi.mocked(createJudgeCompletion).mockReset());

/** A right answer from the tool, plus a claim no tool result supports. */
const UNSUPPORTED_CLAIM: JudgeInput = {
  case: {
    input: { prompt: 'What is the weather in Oslo?' },
    expected: { answer: '20°C and sunny in Oslo.' },
    tags: [],
    metadata: {},
  },
  trial: {
    response: "It's 20°C and sunny in Oslo. It will rain tomorrow.",
    text: "It's 20°C and sunny in Oslo. It will rain tomorrow.",
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'get_weather',
        arguments: { city: 'Oslo' },
        output: 'Oslo: 20°C, sunny',
        isError: false,
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
      text: JSON.stringify({
        reasoning: 'Tomorrow is not in event 1.',
        verdict,
      }),
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

describe('the grounded-in-tools judge', () => {
  it('is a built-in judge, and the label page knows its question', () => {
    expect(getJudge('grounded-in-tools')).toBe(GROUNDED_IN_TOOLS_JUDGE);
    expect(listJudges().map(([name]) => name)).toContain('grounded-in-tools');
    expect(GROUNDED_IN_TOOLS_JUDGE.version).toMatch(/^[0-9a-f]{16,}$/);
    expect(BUILT_IN_JUDGE_QUESTIONS['grounded-in-tools']).toBe(
      GROUNDED_IN_TOOLS_QUESTION
    );
  });

  it('asks the rules ADR 0009 gives the judge', () => {
    // These pin the question's rules on their own: a change to one of them
    // should change this test, not only the prompt file.
    const rules = GROUNDED_IN_TOOLS_QUESTION.split('\n\n');
    const rule = (start: string) => rules.find((r) => r.startsWith(start))!;
    expect(rules[0]).toBe(
      'Is every claim in the final answer supported by a tool result in the trace?'
    );
    // Claims about the assistant's own calls count.
    expect(rule('A claim is anything')).toContain('what the assistant did');
    // Facts derived from results, or given in the request, are supported.
    expect(rule('A claim is supported')).toContain('follows directly');
    expect(rule('A claim is supported')).toContain("the user's request");
    // An answer that only reports a failure can pass.
    expect(rule('Answer "yes"')).toContain('makes no claims');
    // General knowledge and a failed call's result are unsupported.
    expect(rule('Answer "no"')).toContain('general knowledge');
    expect(rule('Answer "no"')).toContain('a call that failed');
    // A result the trace can't show is unknown, not no.
    expect(rule('Answer "unknown"')).toContain('observed="false"');
    expect(rule('Answer "unknown"')).toContain('complete="false"');
    // Correctness and tool choice are other judges' questions.
    expect(rules.at(-1)).toContain(
      "the wrong tool's result is still supported"
    );
  });

  it('asks its one question about the trace, without the reference answer', async () => {
    const requests = model('no');
    const score = await GROUNDED_IN_TOOLS_JUDGE.evaluate(UNSUPPORTED_CLAIM, {});
    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain(`Question: ${GROUNDED_IN_TOOLS_QUESTION}`);
    expect(prompt).toContain('Oslo: 20°C, sunny');
    expect(prompt).toContain('It will rain tomorrow.');
    expect(prompt).not.toContain('<reference_answer>');
    expect(score).toMatchObject({
      score: 0,
      reasoning: 'Tomorrow is not in event 1.',
    });
  });

  it('passes on yes, and answers unknown when the model does', async () => {
    model('yes');
    expect(
      await GROUNDED_IN_TOOLS_JUDGE.evaluate(UNSUPPORTED_CLAIM, {})
    ).toMatchObject({ score: 1 });
    model('unknown');
    expect(
      await GROUNDED_IN_TOOLS_JUDGE.evaluate(UNSUPPORTED_CLAIM, {})
    ).toMatchObject({ unknown: true });
  });

  it("answers unknown without a model call when the client didn't report its calls", async () => {
    const requests = model('yes');
    const score = await GROUNDED_IN_TOOLS_JUDGE.evaluate(
      {
        ...UNSUPPORTED_CLAIM,
        trial: { ...UNSUPPORTED_CLAIM.trial, events: [], evidence: 'none' },
      },
      {}
    );
    expect(requests).toHaveLength(0);
    expect(score).toMatchObject({ unknown: true });
  });
});
