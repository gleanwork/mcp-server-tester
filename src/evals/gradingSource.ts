/**
 * Where a run's grading happens (ADR 0005). A local run and a local
 * `mst grade` grade in this process. `mst grade --env` grades the same way on
 * workers, which record what grading produced; the coordinator then runs the
 * regrade with the records, so every file it writes comes from the code a
 * local regrade runs.
 *
 * The two places grading happens are each trial's assertions and judges
 * (`gradeTrial`) and each case's pairwise judges (`comparePairwise`).
 */
import type { GradingOutcome } from './grading.js';
import type { PairwiseCasePreference } from './pairwiseComparison.js';

/** One trial's grading: a variant's trial of a case. */
interface TrialGradeKey {
  readonly kind: 'trial';
  readonly variant: string;
  readonly caseId: string;
  readonly trial: number;
}

/** One case's pairwise comparison: a candidate's against the baseline. */
interface PairwiseGradeKey {
  readonly kind: 'pairwise';
  readonly candidate: string;
  readonly caseId: string;
}

export type GradeKey = TrialGradeKey | PairwiseGradeKey;

/** What grading produced for one key. */
export type GradeRecord =
  | { readonly key: TrialGradeKey; readonly outcome: GradingOutcome }
  | {
      readonly key: PairwiseGradeKey;
      readonly preferences: PairwiseCasePreference[];
    };

/** A key as a string, for maps. */
export function gradeKeyString(key: GradeKey): string {
  return key.kind === 'trial'
    ? JSON.stringify(['trial', key.variant, key.caseId, key.trial])
    : JSON.stringify(['pairwise', key.candidate, key.caseId]);
}

export interface GradingSource {
  /**
   * Whether judges run in this process, so their preflight (an SDK, a
   * credential) must pass here before any trial is graded.
   */
  readonly judgesRunHere: boolean;
  /** A trial's grading: `grade` grades it here. */
  trial(
    key: TrialGradeKey,
    grade: () => Promise<GradingOutcome>
  ): Promise<GradingOutcome>;
  /** A case's pairwise preferences, one per judge: `judge` judges it here. */
  pairwise(
    key: PairwiseGradeKey,
    judges: readonly string[],
    judge: () => Promise<PairwiseCasePreference[]>
  ): Promise<PairwiseCasePreference[]>;
}

/** Grading in this process: every trial and case is graded here. */
export const LOCAL_GRADING: GradingSource = {
  judgesRunHere: true,
  trial: (_key, grade) => grade(),
  pairwise: (_key, _judges, judge) => judge(),
};

/**
 * A worker's grading (`mst grade-shard`): grades here, and records each
 * result as it's produced. After `stopped()`, nothing more is graded: what
 * isn't recorded is missing on the coordinator, and the next regrade grades
 * it.
 */
export function recordingGrading(options: {
  record(record: GradeRecord): Promise<void>;
  stopped(): boolean;
}): GradingSource {
  const stoppedError = 'Grading stopped: the shard was cancelled.';
  return {
    judgesRunHere: true,
    async trial(key, grade) {
      if (options.stopped()) return missingOutcome(stoppedError);
      const outcome = await grade();
      await options.record({ key, outcome });
      return outcome;
    },
    async pairwise(key, judges, judge) {
      if (options.stopped()) return missingPreferences(judges, stoppedError);
      const preferences = await judge();
      await options.record({ key, preferences });
      return preferences;
    },
  };
}

/**
 * The coordinator's side of `mst grade --env`: each trial's and case's
 * grading as its worker recorded it. One a worker didn't bring back gets a
 * grading error that says why (`missing(key)`), so the regrade is
 * `phases.grade: partial` and the next regrade grades it.
 */
export function gatheredGrading(
  records: ReadonlyMap<string, GradeRecord>,
  missing: (key: GradeKey) => string
): GradingSource {
  return {
    judgesRunHere: false,
    async trial(key) {
      const record = records.get(gradeKeyString(key));
      return record && 'outcome' in record
        ? record.outcome
        : missingOutcome(missing(key));
    },
    async pairwise(key, judges) {
      const record = records.get(gradeKeyString(key));
      return record && 'preferences' in record
        ? record.preferences
        : missingPreferences(judges, missing(key));
    },
  };
}

/** A trial whose grading didn't come back: a grader error, not a failure. */
function missingOutcome(reason: string): GradingOutcome {
  return { scores: { error: { pass: false, error: reason } } };
}

/** A case whose comparison didn't come back: each judge's error. */
function missingPreferences(
  judges: readonly string[],
  reason: string
): PairwiseCasePreference[] {
  return judges.map((judge) => ({ judge, error: reason }));
}
