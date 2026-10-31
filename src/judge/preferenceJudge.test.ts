import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion, preflightJudge } from './judgeClient.js';
import { BUILT_IN_JUDGE_QUESTIONS } from './builtinQuestions.js';
import type { JudgeTrial } from './judgeContract.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import type { PairwiseJudgeInput } from './pairwiseContract.js';
import { PREFERENCE_JUDGE } from './preferenceJudge.js';
import {
  PREFERENCE_LABEL_QUESTION,
  PREFERENCE_QUESTION,
  PREFERENCE_SYSTEM_PROMPT,
} from './prompts/preference.js';
import { judgeIdentity } from './judgeIdentity.js';
import {
  comparePairwise,
  getPairwiseJudge,
  listPairwiseJudges,
} from '../evals/pairwiseComparison.js';
import type { EvalCaseResult } from '../types/reporter.js';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.mocked(createJudgeCompletion).mockReset();
  vi.mocked(preflightJudge).mockClear();
});

function trial(text: string, output: string): JudgeTrial {
  return {
    response: text,
    text,
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'get_weather',
        arguments: { city: 'Oslo' },
        output,
      },
    ],
    evidence: 'structured',
  };
}

const RIGHT = trial('It is 20°C and sunny in Oslo.', '20°C, sunny');
const WRONG = trial('It is 5°C and raining in Oslo.', '20°C, sunny');

const PAIR: PairwiseJudgeInput = {
  case: {
    input: { prompt: 'What is the weather in Oslo?' },
    expected: { answer: '20°C and sunny.' },
    tags: [],
    metadata: {},
  },
  baseline: WRONG,
  candidate: RIGHT,
};

/** A model that answers each call with `reply(prompt)`. */
function model(reply: (prompt: string) => string) {
  const requests: JudgeCompletionRequest[] = [];
  vi.mocked(createJudgeCompletion).mockImplementation(() => async (request) => {
    requests.push(request);
    return {
      text: reply(request.prompt),
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

function answer(preference: string): string {
  return JSON.stringify({ reasoning: 'r', preference });
}

/** The side whose answer says 20°C, wherever it is shown. */
function prefersRight(prompt: string): string {
  const a = prompt.indexOf('<assistant_a>');
  const b = prompt.indexOf('<assistant_b>');
  const right = prompt.indexOf('It is 20°C');
  return answer(right > a && right < b ? 'A' : 'B');
}

describe('the preference judge', () => {
  it('is the built-in pairwise judge, and the label page shows its question', () => {
    expect(getPairwiseJudge('preference')).toBe(PREFERENCE_JUDGE);
    expect(getPairwiseJudge('mst/pairwise-judge/preference')).toBe(
      PREFERENCE_JUDGE
    );
    expect(listPairwiseJudges().map(([name]) => name)).toEqual(['preference']);
    expect(PREFERENCE_JUDGE.version).toMatch(/^[0-9a-f]{16,}$/);
    expect(PREFERENCE_JUDGE.swapPositions).toBe(true);
    expect(BUILT_IN_JUDGE_QUESTIONS.preference).toBe(PREFERENCE_LABEL_QUESTION);
    expect(PREFERENCE_LABEL_QUESTION).toContain(PREFERENCE_QUESTION);
  });

  it('has one identity whether or not the default reference is written out', () => {
    const identity = (options: Record<string, unknown>) =>
      judgeIdentity(
        'preference',
        PREFERENCE_JUDGE,
        PREFERENCE_JUDGE.schema.parse(options) as Record<string, unknown>,
        { reps: 1 }
      );
    expect(identity({})).toBe(identity({ reference: true }));
    expect(identity({})).not.toBe(identity({ reference: false }));
  });

  it('shows the request once, the baseline as A and the candidate as B, with the reference', async () => {
    const requests = model(() => answer('B'));
    const out = await PREFERENCE_JUDGE.compare(PAIR, {});
    expect(out).toMatchObject({
      preference: 'candidate',
      reasoning: 'r',
      provider: 'anthropic',
      version: PREFERENCE_JUDGE.version,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(requests).toHaveLength(1);
    const { system, prompt } = requests[0]!;
    expect(system).toBe(PREFERENCE_SYSTEM_PROMPT);
    expect(prompt.match(/<request>/g)).toHaveLength(1);
    expect(prompt).toContain(
      '<reference_answer>\n20°C and sunny.\n</reference_answer>'
    );
    expect(prompt.indexOf('It is 5°C')).toBeLessThan(
      prompt.indexOf('<assistant_b>')
    );
    expect(prompt.indexOf('It is 20°C')).toBeGreaterThan(
      prompt.indexOf('<assistant_b>')
    );
    expect(prompt).toContain(`Question: ${PREFERENCE_QUESTION}`);
  });

  it('hides the reference answer with reference: false', async () => {
    const requests = model(() => answer('tie'));
    await PREFERENCE_JUDGE.compare(PAIR, { reference: false });
    expect(requests[0]!.prompt).not.toContain('<reference_answer>');
  });

  it('reads A, B and tie in any case', async () => {
    for (const [reply, side] of [
      ['A', 'baseline'],
      ['b', 'candidate'],
      ['TIE', 'tie'],
    ] as const) {
      model(() => answer(reply));
      await expect(PREFERENCE_JUDGE.compare(PAIR, {})).resolves.toMatchObject({
        preference: side,
      });
    }
  });

  it('asks once more when it cannot read the answer, and sums the usage', async () => {
    let calls = 0;
    model(() => (calls++ === 0 ? 'A, I think' : answer('A')));
    const out = await PREFERENCE_JUDGE.compare(PAIR, {});
    expect(out.preference).toBe('baseline');
    expect(out.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 });

    model(() => '{"reasoning": "r", "preference": "C"}');
    await expect(PREFERENCE_JUDGE.compare(PAIR, {})).rejects.toThrow(
      /isn't \{"reasoning", "preference": "A" \| "B" \| "tie"\}/
    );
  });

  it('rejects options it does not know, and preflights its LLM settings only', async () => {
    await expect(
      PREFERENCE_JUDGE.compare(PAIR, { rubric: 'x' })
    ).rejects.toThrow();
    await PREFERENCE_JUDGE.preflight!({
      model: 'claude-sonnet-4-6',
      reference: false,
      maxToolOutputSize: 100,
    });
    expect(preflightJudge).toHaveBeenCalledWith({ model: 'claude-sonnet-4-6' });
  });
});

function result(id: string, judged: JudgeTrial): EvalCaseResult {
  return {
    id,
    datasetName: 'd',
    toolName: '',
    source: 'eval',
    pass: true,
    scores: {},
    durationMs: 1,
    request: { input: 'What is the weather in Oslo?' },
    response: { response: judged.text, events: judged.events },
    traceEvidence: 'structured',
  } as EvalCaseResult;
}

describe('the preference judge in a comparison', () => {
  async function compare() {
    return comparePairwise({
      baseline: { caseResults: [result('oslo', WRONG)] },
      candidate: { caseResults: [result('oslo', RIGHT)] },
      judges: [{ type: 'preference' }],
    });
  }

  it('asks in both orders, and agrees with itself when the order does not sway it', async () => {
    const requests = model(prefersRight);
    const out = await compare();
    expect(requests).toHaveLength(2);
    expect(out.cases[0]!.preferences[0]).toMatchObject({
      judge: 'preference',
      preference: 'candidate',
      consistent: true,
    });
    expect(out.summary[0]).toMatchObject({
      candidateWins: 1,
      consistency: 1,
    });
  });

  it('calls a preference that only follows the order a tie, and not consistent', async () => {
    model(() => answer('A'));
    const out = await compare();
    expect(out.cases[0]!.preferences[0]).toMatchObject({
      preference: 'tie',
      consistent: false,
    });
    // No vote was a tie: the reasoning kept is the swapped order's, and says so.
    expect(out.cases[0]!.preferences[0]!.reasoning).toMatch(
      /^\(With the runs swapped, so the candidate was shown first, as A or the baseline\.\) r$/
    );
  });

  it('keeps the forward reasoning when the forward order gave the preference', async () => {
    let calls = 0;
    model(() =>
      JSON.stringify({
        reasoning: calls++ === 0 ? 'forward' : 'swapped',
        preference: calls === 1 ? 'B' : 'tie',
      })
    );
    const out = await compare();
    expect(out.cases[0]!.preferences[0]).toMatchObject({
      preference: 'candidate',
      reasoning: 'forward',
    });
  });
});
