import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_GRADING,
  gatheredGrading,
  gradeKeyString,
  recordingGrading,
  type GradeRecord,
} from './gradingSource.js';

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
