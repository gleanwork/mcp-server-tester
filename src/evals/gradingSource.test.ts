import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_GRADING,
  gatheredGrading,
  gradeKeyString,
  recordingGrading,
  resumedGrading,
  type GradeRecord,
  type PreviousGrades,
} from './gradingSource.js';
import type { GradingOutcome } from './grading.js';

const trialKey = {
  kind: 'trial',
  variant: 'v',
  caseId: 'c',
  trial: 1,
} as const;
const pairKey = { kind: 'pairwise', candidate: 'v', caseId: 'c' } as const;

describe('grading sources (ADR 0005)', () => {
  it('local grading grades here', async () => {
    const grade = vi.fn(async () => ({ scores: {} }));
    await LOCAL_GRADING.trial(trialKey, grade);
    expect(grade).toHaveBeenCalledOnce();
    expect(LOCAL_GRADING.judgesRunHere).toBe(true);
  });

  it('recording grades here and records each result; once stopped, it grades and records nothing', async () => {
    const records: GradeRecord[] = [];
    let stopped = false;
    const source = recordingGrading({
      record: async (record) => {
        records.push(record);
      },
      stopped: () => stopped,
    });
    const outcome = { scores: { judge: { pass: true, score: 1 } } };
    expect(await source.trial(trialKey, async () => outcome)).toBe(outcome);
    const preferences = [{ judge: 'j', preference: 'tie' as const }];
    expect(await source.pairwise(pairKey, ['j'], async () => preferences)).toBe(
      preferences
    );
    expect(records).toEqual([
      { key: trialKey, outcome },
      { key: pairKey, preferences },
    ]);
    stopped = true;
    const grade = vi.fn(async () => outcome);
    const judge = vi.fn(async () => preferences);
    expect(await source.trial(trialKey, grade)).toEqual({
      scores: {
        error: {
          pass: false,
          error: 'Grading stopped: the shard was cancelled.',
        },
      },
    });
    expect(await source.pairwise(pairKey, ['j', 'k'], judge)).toEqual([
      { judge: 'j', error: 'Grading stopped: the shard was cancelled.' },
      { judge: 'k', error: 'Grading stopped: the shard was cancelled.' },
    ]);
    expect(grade).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(records).toHaveLength(2);
  });

  it('gathered grading reads the records, never grades, and says why one is missing', async () => {
    const outcome = { scores: { judge: { pass: false, score: 0 } } };
    const records = new Map<string, GradeRecord>([
      [gradeKeyString(trialKey), { key: trialKey, outcome }],
    ]);
    const source = gatheredGrading(records, (key) => `Missing: ${key.caseId}`);
    expect(source.judgesRunHere).toBe(false);
    const grade = vi.fn(async () => ({ scores: {} }));
    expect(await source.trial(trialKey, grade)).toBe(outcome);
    expect(await source.trial({ ...trialKey, trial: 0 }, grade)).toEqual({
      scores: { error: { pass: false, error: 'Missing: c' } },
    });
    expect(await source.pairwise(pairKey, ['j'], vi.fn())).toEqual([
      { judge: 'j', error: 'Missing: c' },
    ]);
    expect(grade).not.toHaveBeenCalled();
  });
});

describe('resumed grading (mst grade --resume)', () => {
  const kept = { pass: true, score: 1, judgeName: 'kept' };
  const timedOut = { pass: false, judgeName: 'late', error: 'timed out' };
  const previous: PreviousGrades = {
    runId: '20261014T182351Z-78a072.g2',
    trials: new Map([
      [
        gradeKeyString(trialKey),
        {
          scores: {
            judge: {
              pass: false,
              error: 'timed out',
              judgeResults: [kept, timedOut],
            },
          },
        },
      ],
      [gradeKeyString({ ...trialKey, trial: 0 }), { scores: { judge: kept } }],
    ]),
    pairwise: new Map([
      [
        gradeKeyString(pairKey),
        [
          { judge: 'j', preference: 'candidate' as const },
          { judge: 'k', error: 'timed out' },
        ],
      ],
    ]),
    comparable: new Map(),
  };

  it('grades a complete trial here with its verdicts, and sends the rest on with theirs', async () => {
    const sent = vi.fn(async () => ({ scores: { judge: kept } }));
    const source = resumedGrading(previous, {
      judgesRunHere: false,
      trial: (_key, grade) => sent().then(() => grade()),
      pairwise: async () => [],
    });
    const grade = vi.fn(
      async (_given?: GradingOutcome): Promise<GradingOutcome> => ({
        scores: {},
      })
    );
    await source.trial({ ...trialKey, trial: 0 }, grade);
    expect(sent).not.toHaveBeenCalled();
    expect(grade).toHaveBeenLastCalledWith(
      previous.trials.get(gradeKeyString({ ...trialKey, trial: 0 }))
    );
    await source.trial(trialKey, grade);
    expect(sent).toHaveBeenCalledOnce();
    // The trial goes on with its verdicts, for the judge that has one.
    expect(grade).toHaveBeenLastCalledWith(
      previous.trials.get(gradeKeyString(trialKey))
    );
    expect(source.counts).toMatchObject({ reusedTrials: 1, gradedTrials: 1 });
  });

  it("keeps a trial's verdicts when its grading doesn't come back", async () => {
    const source = resumedGrading(
      previous,
      gatheredGrading(new Map(), () => 'Missing: shard lost')
    );
    const outcome = await source.trial(trialKey, vi.fn());
    expect(outcome.scores.judge?.judgeResults).toEqual([kept, timedOut]);
    expect(outcome.scores.error).toEqual({
      pass: false,
      error: 'Missing: shard lost',
    });
  });

  it("runs only a case's pairwise judges without a preference, and keeps the judges' order", async () => {
    const judge = vi.fn(async (only?: readonly string[]) =>
      (only ?? []).map((name) => ({ judge: name, preference: 'tie' as const }))
    );
    const source = resumedGrading(previous, LOCAL_GRADING);
    expect(await source.pairwise(pairKey, ['j', 'k'], judge)).toEqual([
      { judge: 'j', preference: 'candidate' },
      { judge: 'k', preference: 'tie' },
    ]);
    expect(judge).toHaveBeenCalledWith(['k']);
    // A case compared in full needs no judge.
    judge.mockClear();
    expect(
      await source.pairwise({ ...pairKey, caseId: 'other' }, [], judge)
    ).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});
