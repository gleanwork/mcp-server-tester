import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JudgeClientModule from './judgeClient.js';
import { createJudgeCompletion } from './judgeClient.js';
import { getJudge } from './builtinJudges.js';
import { CRITERIA_JUDGE } from './criteriaJudge.js';
import { evaluateJudge, type JudgeRequest } from './evaluateJudge.js';
import type { JudgeCompletionRequest } from './llmJudge.js';
import { criterionQuestion } from './prompts/criteria.js';
import { judgedItems } from '../evals/judgedItems.js';
import type { StoredRun } from '../evals/runFormat.js';
import { formatLabels, parseCsv, parseLabels } from '../evals/labels.js';
import type { GraderScore } from '../types/index.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { z } from 'zod';

vi.mock('./judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudgeCompletion: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.mocked(createJudgeCompletion).mockReset();
  resetPluginsForTests();
});

const CITES = {
  id: 'cites-source',
  text: 'The answer names the file it read.',
};
const BRIEF = { id: 'brief', text: 'The answer is one sentence.' };
const POLITE = {
  id: 'polite',
  text: 'The answer thanks the user.',
  required: false,
};

/** A model that answers each criterion from `verdicts`, by its text; `yes` by default. */
function model(
  verdicts: Record<string, string | string[]> = {}
): JudgeCompletionRequest[] {
  const requests: JudgeCompletionRequest[] = [];
  const asked = new Map<string, number>();
  vi.mocked(createJudgeCompletion).mockImplementation(() => async (request) => {
    requests.push(request);
    const id =
      [CITES, BRIEF, POLITE].find((c) =>
        request.prompt.includes(criterionQuestion(c.text))
      )?.id ?? 'other';
    const times = asked.get(id) ?? 0;
    asked.set(id, times + 1);
    const given = verdicts[id] ?? 'yes';
    const verdict = Array.isArray(given) ? given[times]! : given;
    return {
      text: JSON.stringify({ reasoning: `${id} ${verdict}`, verdict }),
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  return requests;
}

const RUN = {
  evalCase: { id: 'c1', input: 'What port does the service use?' },
};

function request(
  criteria: unknown[],
  extra: Partial<JudgeRequest> = {}
): JudgeRequest {
  return {
    judge: 'criteria',
    options: { criteria },
    label: 'criteria',
    threshold: 0.5,
    reps: 1,
    ...extra,
  };
}

async function grade(
  criteria: unknown[],
  extra: Partial<JudgeRequest> = {}
): Promise<GraderScore> {
  const result = await evaluateJudge(
    'The port is 7341, from config/service.json.',
    request(criteria, extra),
    RUN
  );
  // As grading records it: the message is the score's `details`.
  return {
    pass: result.pass,
    ...(result.details as object),
    details: result.message,
  } as GraderScore;
}

describe('the criteria judge', () => {
  it('is a built-in judge whose options are the case’s criteria', () => {
    expect(getJudge('criteria')).toBe(CRITERIA_JUDGE);
    const parse = (criteria: unknown) =>
      CRITERIA_JUDGE.schema.safeParse({ criteria }).success;
    expect(parse([CITES, POLITE])).toBe(true);
    expect(parse([])).toBe(false);
    expect(parse([CITES, { ...BRIEF, id: 'cites-source' }])).toBe(false);
    expect(parse([{ id: 'has#hash', text: 'x' }])).toBe(false);
    expect(parse([{ id: 'x', text: '  ' }])).toBe(false);
    expect(parse([{ ...CITES, weight: 2 }])).toBe(false);
  });

  it('asks each criterion in its own call, with the reference, and passes when every required one does', async () => {
    const requests = model({ polite: 'no' });
    const score = await grade([CITES, BRIEF, POLITE], {
      reference: '7341',
    });
    expect(requests).toHaveLength(3);
    for (const r of requests) expect(r.prompt).toContain('<reference_answer>');
    expect(requests[0]!.prompt).toContain(
      'Criterion: The answer names the file it read.'
    );
    // A criterion that isn't required doesn't decide the pass.
    expect(score.pass).toBe(true);
    expect(score.criteria).toEqual([
      expect.objectContaining({
        id: 'cites-source',
        text: CITES.text,
        verdict: 'pass',
      }),
      expect.objectContaining({ id: 'brief', verdict: 'pass' }),
      expect.objectContaining({
        id: 'polite',
        required: false,
        verdict: 'fail',
        reasoning: 'polite no',
      }),
    ]);
  });

  it('fails on a required no, and is unknown on a required unknown', async () => {
    model({ brief: 'no' });
    expect((await grade([CITES, BRIEF])).pass).toBe(false);
    model({ brief: 'unknown' });
    const unknown = await grade([CITES, BRIEF]);
    expect(unknown).toMatchObject({ pass: false, unknown: true });
    // An unknown judge still reports the criteria it could answer.
    expect(unknown.criteria?.map((c) => c.verdict)).toEqual([
      'pass',
      'unknown',
    ]);
  });

  it('gives a criterion one identity wherever it is, and a new one when it changes', async () => {
    model();
    const [a, b, changed] = [
      await grade([CITES, BRIEF]),
      await grade([CITES, POLITE]),
      await grade([{ ...CITES, text: 'The answer names its source.' }, BRIEF]),
    ];
    const identity = (score: GraderScore, id: string) =>
      score.criteria!.find((c) => c.id === id)!.judgeIdentity;
    expect(identity(a, 'cites-source')).toBe(identity(b, 'cites-source'));
    expect(identity(a, 'cites-source')).not.toBe(a.judgeIdentity);
    expect(identity(a, 'cites-source')).not.toBe(identity(a, 'brief'));
    expect(identity(changed, 'cites-source')).not.toBe(
      identity(a, 'cites-source')
    );
    // The judge model is part of it.
    const other = await grade([CITES], {
      options: { criteria: [CITES], model: 'claude-haiku-4-5' },
    });
    expect(identity(other, 'cites-source')).not.toBe(
      identity(a, 'cites-source')
    );
    // `required` decides the case, not the criterion's verdict.
    const optional = await grade([{ ...CITES, required: false }]);
    const explicit = await grade([{ ...CITES, required: true }]);
    expect(identity(optional, 'cites-source')).toBe(
      identity(a, 'cites-source')
    );
    expect(identity(explicit, 'cites-source')).toBe(
      identity(a, 'cites-source')
    );
  });

  it("takes each criterion's majority over reps, and a tie is unknown", async () => {
    model({ 'cites-source': ['no', 'yes', 'no'], brief: ['yes', 'no', 'yes'] });
    const three = await grade([CITES, BRIEF], { reps: 3 });
    expect(three.criteria?.map((c) => c.verdict)).toEqual(['fail', 'pass']);
    expect(three.pass).toBe(false);
    // The reasoning is from a rep that agrees with the verdict.
    expect(three.criteria?.map((c) => c.reasoning)).toEqual([
      'cites-source no',
      'brief yes',
    ]);
    model({ 'cites-source': ['no', 'yes'] });
    const two = await grade([CITES], { reps: 2 });
    expect(two.criteria?.[0]?.verdict).toBe('unknown');
    expect(two).toMatchObject({ pass: false, unknown: true });
  });

  it("passes when every required criterion's majority passes, though no rep passed whole", async () => {
    // Reps 1 and 2 each fail one criterion; each criterion passes 2 to 1.
    model({
      'cites-source': ['no', 'yes', 'yes'],
      brief: ['yes', 'no', 'yes'],
    });
    const score = await grade([CITES, BRIEF], { reps: 3 });
    expect(score.criteria?.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    // The score, reasoning and sub-scores are the criteria's, not a rep's.
    expect(score).toMatchObject({
      pass: true,
      score: 1,
      reasoning: 'cites-source: cites-source yes\nbrief: brief yes',
      subScores: {
        'cites-source': { score: 1, pass: true },
        brief: { score: 1, pass: true },
      },
    });
    expect(score.unknown).toBeUndefined();
    // A failure gives the share of required criteria that passed, and why.
    model({ 'cites-source': ['yes', 'no', 'no'] });
    const failed = await grade([CITES, BRIEF], { reps: 3 });
    expect(failed).toMatchObject({
      pass: false,
      score: 0.5,
      reasoning: 'cites-source: cites-source no',
    });
    expect(failed.details).toContain('cites-source failed');
    expect(failed.details).not.toContain('threshold');
  });

  describe('on a plugin judge', () => {
    function install(evaluate: (rep: number) => Record<string, unknown>): void {
      let rep = 0;
      installPlugins([
        {
          meta: { name: 'listed', namespace: 'listed' },
          judges: {
            checks: {
              schema: z.object({}),
              evaluate: async () => evaluate(rep++) as never,
            },
          },
        },
      ]);
    }
    async function judged(reps = 1): Promise<Record<string, unknown>> {
      const result = await evaluateJudge(
        'x',
        {
          judge: 'listed/judge/checks',
          options: {},
          label: 'listed/judge/checks',
          threshold: 0.5,
          reps,
        },
        RUN
      );
      return { pass: result.pass, ...result.details };
    }

    it('keeps its own verdict when no criterion is required', async () => {
      install(() => ({
        score: 0.1,
        pass: false,
        criteria: [{ id: 'note', required: false, verdict: 'pass' }],
      }));
      expect(await judged()).toMatchObject({ pass: false, score: 0.1 });
    });

    it('keeps the criteria of the reps before one that skips', async () => {
      install((rep) =>
        rep === 0
          ? { score: 1, criteria: [{ id: 'supported', verdict: 'pass' }] }
          : { score: 0, skipped: true }
      );
      expect(await judged(2)).toMatchObject({
        skipped: true,
        criteria: [{ id: 'supported', verdict: 'unknown' }],
      });
    });

    it('checks the criteria a skip lists', async () => {
      install(() => ({
        score: 0,
        skipped: true,
        criteria: [{ id: 'a#b', verdict: 'pass' }],
      }));
      expect(await judged()).toMatchObject({
        pass: false,
        error: expect.stringContaining('whose id has a "#"'),
      });
    });
  });

  it("keeps a skipping judge's criteria, each unknown", async () => {
    installPlugins([
      {
        meta: { name: 'skips', namespace: 'skips' },
        judges: {
          checks: {
            schema: z.object({}),
            evaluate: async () => ({
              score: 0,
              skipped: true,
              reasoning: 'no answer to check',
              criteria: [{ id: 'supported', verdict: 'pass' }],
            }),
          },
        },
      },
    ]);
    const result = await evaluateJudge(
      'x',
      {
        judge: 'skips/judge/checks',
        options: {},
        label: 'skips/judge/checks',
        threshold: 0.5,
        reps: 1,
      },
      RUN
    );
    expect(result.details).toMatchObject({
      skipped: true,
      criteria: [
        {
          id: 'supported',
          verdict: 'unknown',
          judgeIdentity: expect.any(String),
        },
      ],
    });
  });

  it("asks even when the client didn't report its calls", async () => {
    const requests = model();
    const result = await evaluateJudge('Port 7341.', request([BRIEF]), {
      evalCase: RUN.evalCase,
      evidence: 'none',
    });
    expect(requests).toHaveLength(1);
    expect(result.pass).toBe(true);
  });
});

describe("a criteria judge's verdicts", () => {
  it('are labeled one criterion at a time, with its text as the question', async () => {
    model({ brief: 'no' });
    const score = await grade([CITES, BRIEF]);
    const stored = {
      summary: {
        variants: [
          {
            name: 'only',
            result: {
              caseResults: [
                { id: 'c1', request: { input: 'Q' }, scores: { judge: score } },
              ],
            },
          },
        ],
      },
    } as unknown as StoredRun;
    const items = judgedItems(stored);
    expect(items.map((i) => [i.judge, i.criterion, i.verdict])).toEqual([
      ['criteria', 'cites-source', 'pass'],
      ['criteria', 'brief', 'fail'],
    ]);
    expect(items[0]).toMatchObject({
      question: CITES.text,
      judgeIdentity: score.criteria![0]!.judgeIdentity,
      reasoning: 'cites-source yes',
    });
    // An export carries each criterion's text, and reads back.
    const sheet = parseCsv(formatLabels('csv', stored, items, []));
    const header = sheet[0]!;
    expect(
      sheet.slice(1).map((row) => row[header.indexOf('question')])
    ).toEqual([CITES.text, BRIEF.text]);
    const filled = formatLabels('csv', stored, items, []).replace(
      /,pass,,,,,/,
      ',pass,fail,,,,'
    );
    expect(parseLabels('csv', filled, 'labels.csv')).toEqual([
      expect.objectContaining({
        judge: 'criteria',
        criterion: 'cites-source',
        label: 'fail',
      }),
    ]);
  });
});
