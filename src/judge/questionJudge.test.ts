import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion, preflightJudge } from './judgeClient.js';
import { buildJudgeTrial, type JudgeInput } from './judgeContract.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import { QUESTION_SYSTEM_PROMPT } from './prompts/question.js';
import {
  combineAnswers,
  defineQuestionJudge,
  parseQuestionAnswer,
  type AnsweredQuestion,
} from './questionJudge.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => vi.mocked(createJudgeCompletion).mockReset());

const INPUT: JudgeInput = {
  case: {
    input: { prompt: 'Why did checkout fail?' },
    expected: { answer: 'An expired certificate' },
    tags: [],
    metadata: {},
  },
  trial: {
    response: 'An expired certificate.',
    text: 'An expired certificate.',
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        output: 'x'.repeat(50),
      },
    ],
    evidence: 'structured',
  },
};

/** A model that answers each question from `answers`, by its text. */
function model(answers: Record<string, string>) {
  const requests: JudgeCompletionRequest[] = [];
  vi.mocked(createJudgeCompletion).mockImplementation(() => async (request) => {
    requests.push(request);
    const question = /Question: (.*)\n/.exec(request.prompt)![1]!;
    return {
      text: answers[question]!,
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

function answered(
  id: string,
  verdict: 'yes' | 'no' | 'unknown',
  required?: boolean
): AnsweredQuestion {
  return {
    question: {
      id,
      text: `${id}?`,
      ...(required !== undefined ? { required } : {}),
    },
    verdict,
    reasoning: `${id} is ${verdict}`,
    usage: { inputTokens: 1 },
  };
}

describe('parseQuestionAnswer', () => {
  it('reads the JSON, fenced or after prose, in any case', () => {
    expect(
      parseQuestionAnswer('{"reasoning": "event 1", "verdict": "yes"}')
    ).toEqual({ reasoning: 'event 1', verdict: 'yes' });
    expect(
      parseQuestionAnswer('```json\n{"verdict": "NO", "reasoning": "r"}\n```')
    ).toEqual({ reasoning: 'r', verdict: 'no' });
    expect(
      parseQuestionAnswer(
        'Event {1} shows it.\n{"reasoning": "r", "verdict": "Unknown"}'
      )
    ).toEqual({ reasoning: 'r', verdict: 'unknown' });
  });

  it('reads an answer whose reasoning quotes words without escaping them', () => {
    // A real answer from a judge model: not JSON, but its verdict is plain.
    expect(
      parseQuestionAnswer(
        '{"reasoning":"The call failed, yet the answer asserts "20°C and sunny" without a tool result.","verdict":"no"}'
      )
    ).toEqual({
      reasoning:
        'The call failed, yet the answer asserts "20°C and sunny" without a tool result.',
      verdict: 'no',
    });
    expect(
      parseQuestionAnswer(
        '```json\n{"verdict": "Yes", "reasoning": "It says "done"."}\n```'
      )
    ).toEqual({ reasoning: 'It says "done".', verdict: 'yes' });
  });

  it('reads no verdict from a malformed answer that has two, or prose around it', () => {
    // The reasoning may quote a verdict, so two leave the answer unknown to us.
    expect(() =>
      parseQuestionAnswer(
        '{"reasoning":"It isn\'t "verdict": "yes" as claimed","verdict":"no"}'
      )
    ).toThrow(/isn't \{"reasoning", "verdict"/);
    expect(() =>
      parseQuestionAnswer(
        'I think {"reasoning":"a "b" c","verdict":"no"} or maybe yes'
      )
    ).toThrow(/isn't \{"reasoning", "verdict"/);
  });

  it("throws on an answer that isn't yes, no or unknown, and names a cut-off answer", () => {
    expect(() =>
      parseQuestionAnswer('{"reasoning": "r", "verdict": "maybe"}')
    ).toThrow(/isn't \{"reasoning", "verdict"/);
    expect(() => parseQuestionAnswer('{"reasoning": "r", "verd', true)).toThrow(
      /cut off at its token limit/
    );
  });
});

describe('combineAnswers', () => {
  it('fails on a required no, else is unknown on a required unknown, else passes', () => {
    expect(
      combineAnswers([answered('a', 'yes'), answered('b', 'no')])
    ).toMatchObject({ pass: false, score: 0, reasoning: 'b: b is no' });
    expect(
      combineAnswers([answered('a', 'unknown'), answered('b', 'no')])
    ).toMatchObject({ pass: false });
    const unknown = combineAnswers([
      answered('a', 'yes'),
      answered('b', 'unknown'),
    ]);
    expect(unknown).toMatchObject({
      unknown: true,
      reasoning: 'b: b is unknown',
    });
    expect(unknown.pass).toBeUndefined();
    expect(combineAnswers([answered('a', 'yes')])).toMatchObject({
      pass: true,
      score: 1,
      reasoning: 'a is yes',
    });
  });

  it("doesn't let a question that isn't required decide, but records it", () => {
    const score = combineAnswers([
      answered('a', 'yes'),
      answered('b', 'no', false),
      answered('c', 'unknown', false),
    ]);
    expect(score).toMatchObject({ pass: true, usage: { inputTokens: 3 } });
    // Answered questions are sub-scores; every answer is in metadata.
    expect(score.subScores).toEqual({
      a: { score: 1, pass: true, reasoning: 'a is yes' },
      b: { score: 0, pass: false, reasoning: 'b is no' },
    });
    expect(score.metadata).toEqual({
      questions: [
        { id: 'a', verdict: 'yes', reasoning: 'a is yes' },
        { id: 'b', verdict: 'no', required: false, reasoning: 'b is no' },
        {
          id: 'c',
          verdict: 'unknown',
          required: false,
          reasoning: 'c is unknown',
        },
      ],
    });
  });
});

describe('defineQuestionJudge', () => {
  const spec = {
    description: 'Checks two things.',
    prompts: { first: 'Is the first thing right?' },
    options: { strict: z.boolean().optional() },
    questions: (_input: JudgeInput, options: { strict?: boolean }) => [
      { id: 'first', text: 'Is the first thing right?' },
      {
        id: 'second',
        text: 'Is the second thing right?',
        required: options.strict === true,
      },
    ],
  };

  it('asks each question in its own model call, about the rendered trace', async () => {
    const requests = model({
      'Is the first thing right?': '{"reasoning": "event 1", "verdict": "yes"}',
      'Is the second thing right?': '{"reasoning": "no", "verdict": "no"}',
    });
    const judge = defineQuestionJudge(spec);
    const score = await judge.evaluate(INPUT, {
      provider: 'openai',
      model: 'gpt-test',
      maxToolOutputSize: 10,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.system).toBe(QUESTION_SYSTEM_PROMPT);
      expect(request.prompt).toContain('<request>\nWhy did checkout fail?');
      // The trace is cut to maxToolOutputSize, which the model never sees.
      expect(request.prompt).toContain('cut="first 10 of 50 bytes"');
      // The reference is left out unless the judge asks for it.
      expect(request.prompt).not.toContain('reference_answer');
    }
    expect(vi.mocked(createJudgeCompletion)).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-test',
    });
    // The second question isn't required unless strict.
    expect(score).toMatchObject({
      pass: true,
      provider: 'openai',
      model: 'gpt-test',
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    const strict = await judge.evaluate(INPUT, { strict: true });
    expect(strict).toMatchObject({
      pass: false,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('shows the reference answer to a judge that asks for it', async () => {
    const requests = model({
      'Is the first thing right?': '{"reasoning": "r", "verdict": "yes"}',
      'Is the second thing right?': '{"reasoning": "r", "verdict": "yes"}',
    });
    await defineQuestionJudge({ ...spec, reference: true }).evaluate(INPUT, {});
    expect(requests[0]!.prompt).toContain(
      '<reference_answer>\nAn expired certificate\n</reference_answer>'
    );
  });

  it("answers unknown without a model call when the client didn't report its tool calls", async () => {
    const requests = model({
      'Is the first thing right?': '{"reasoning": "r", "verdict": "yes"}',
      'Is the second thing right?': '{"reasoning": "r", "verdict": "yes"}',
    });
    const unrecorded: JudgeInput = {
      ...INPUT,
      trial: { ...INPUT.trial, events: [], evidence: 'none' },
    };
    expect(
      await defineQuestionJudge(spec).evaluate(unrecorded, {})
    ).toMatchObject({
      unknown: true,
      reasoning: expect.stringContaining("didn't report"),
    });
    expect(requests).toHaveLength(0);
    // So does a trial with no evidence level: a tool result.
    expect(
      await defineQuestionJudge(spec).evaluate(
        { ...INPUT, trial: { ...INPUT.trial, evidence: undefined } },
        {}
      )
    ).toMatchObject({ unknown: true });
    expect(requests).toHaveLength(0);
    // A client trial whose client declares no evidence (the mst client in a
    // Playwright test) has its trace, and is asked about it.
    const clientResponse = {
      response: 'An expired certificate.',
      toolCalls: [{ name: 'search', arguments: {}, output: 'expired' }],
    };
    expect(
      await defineQuestionJudge(spec).evaluate(
        {
          case: INPUT.case,
          trial: buildJudgeTrial(clientResponse, { clientResponse }),
        },
        {}
      )
    ).toMatchObject({ pass: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.prompt).toContain(
      '<event n="1" kind="tool_call" name="search">'
    );
    requests.length = 0;
    // A judge whose questions don't need the trace still asks them.
    expect(
      await defineQuestionJudge({ ...spec, needsTrace: false }).evaluate(
        unrecorded,
        {}
      )
    ).toMatchObject({ pass: true });
    expect(requests).toHaveLength(2);
  });

  it('skips a trial it has no questions for, without a model call', async () => {
    const requests = model({});
    const judge = defineQuestionJudge({ ...spec, questions: () => [] });
    expect(await judge.evaluate(INPUT, {})).toMatchObject({ skipped: true });
    expect(requests).toHaveLength(0);
  });

  it('rejects options it does not know, and preflights its LLM settings only', async () => {
    const judge = defineQuestionJudge(spec);
    expect(judge.schema.safeParse({ strict: true, model: 'm' }).success).toBe(
      true
    );
    expect(judge.schema.safeParse({ rubric: 'correctness' }).success).toBe(
      false
    );
    await judge.preflight!({ strict: true, provider: 'google' });
    expect(vi.mocked(preflightJudge)).toHaveBeenCalledWith({
      provider: 'google',
    });
  });

  it('has a version that changes with its prompts, and with whether it shows the reference', () => {
    const version = defineQuestionJudge(spec).version;
    expect(version).toMatch(/^[0-9a-f]+$/);
    expect(defineQuestionJudge(spec).version).toBe(version);
    expect(
      defineQuestionJudge({ ...spec, prompts: { first: 'Changed?' } }).version
    ).not.toBe(version);
    expect(defineQuestionJudge({ ...spec, reference: true }).version).not.toBe(
      version
    );
  });

  it("defines a judge whose questions need what the sample doesn't have", () => {
    // A criteria-style judge: its questions come from the case, and
    // `requires` keeps evaluate() from calling them without criteria.
    const criteria = {
      ...spec,
      requires: ['case.expected.criteria'],
      questions: (input: JudgeInput) =>
        Object.entries(
          input.case.expected.criteria as Record<string, string>
        ).map(([id, text]) => ({ id, text })),
    };
    expect(defineQuestionJudge(criteria).version).toMatch(/^[0-9a-f]+$/);
    // One whose questions throw on the sample is defined too.
    expect(
      defineQuestionJudge({
        ...spec,
        questions: () => {
          throw new Error('needs a real case');
        },
      }).version
    ).toMatch(/^[0-9a-f]+$/);
  });

  it('has a version that changes with the questions it asks, whether each is required, and whether it needs the trace', () => {
    const version = defineQuestionJudge(spec).version;
    expect(
      defineQuestionJudge({ ...spec, needsTrace: false }).version
    ).not.toBe(version);
    expect(
      defineQuestionJudge({
        ...spec,
        questions: () => [
          { id: 'first', text: 'Is the first thing right?' },
          { id: 'second', text: 'Is the second thing right?', required: true },
        ],
      }).version
    ).not.toBe(version);
    // The same questions, written another way, are the same judge: a
    // question is required unless it says otherwise.
    expect(
      defineQuestionJudge({
        ...spec,
        questions: () => [
          { id: 'first', text: 'Is the first thing right?', required: true },
          { id: 'second', text: 'Is the second thing right?', required: false },
        ],
      }).version
    ).toBe(version);
  });
});
