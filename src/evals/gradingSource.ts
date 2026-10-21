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
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { GradingOutcome } from './grading.js';
import type { PairwiseCasePreference } from './pairwiseComparison.js';
import type { GraderScore } from '../types/index.js';

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
  /**
   * A trial's grading: `grade` grades it here, reusing the judge results
   * in `previous` that have a verdict (`mst grade --resume`).
   */
  trial(
    key: TrialGradeKey,
    grade: (previous?: GradingOutcome) => Promise<GradingOutcome>
  ): Promise<GradingOutcome>;
  /**
   * A case's pairwise preferences, one per judge: `judge` judges it here,
   * with only the judges `only` names when given.
   */
  pairwise(
    key: PairwiseGradeKey,
    judges: readonly string[],
    judge: (only?: readonly string[]) => Promise<PairwiseCasePreference[]>
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

/**
 * What an earlier grading of the same traces produced (`mst grade --resume`):
 * each graded trial's scores and each compared case's preferences, by key.
 */
export interface PreviousGrades {
  /** The run whose grades these are. */
  readonly runId: string;
  readonly trials: ReadonlyMap<string, GradingOutcome>;
  readonly pairwise: ReadonlyMap<string, readonly PairwiseCasePreference[]>;
  /**
   * Each variant's cases a pairwise judge compares: those whose client ran
   * (one a grader couldn't score included).
   */
  readonly comparable: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The grades a stored run's summary (with its case results) holds. */
export function previousGrades(
  runId: string,
  summary: EvaluationSummary
): PreviousGrades {
  const trials = new Map<string, GradingOutcome>();
  const comparable = new Map<string, Set<string>>();
  for (const result of summary.results) {
    const variant = result.variant ?? 'default';
    if (!result.error || result.gradingError !== undefined) {
      const cases = comparable.get(variant) ?? new Set<string>();
      comparable.set(variant, cases.add(result.id));
    }
    const list = result.trialResults?.length ? result.trialResults : [result];
    for (const [trial, stored] of list.entries()) {
      // A trial no grader scored: its client failed, or it wasn't graded.
      if (!stored.scores) continue;
      trials.set(
        gradeKeyString({ kind: 'trial', variant, caseId: result.id, trial }),
        { scores: stored.scores }
      );
    }
  }
  const pairwise = new Map<string, readonly PairwiseCasePreference[]>();
  for (const variant of summary.variants)
    for (const compared of variant.pairwise?.cases ?? [])
      pairwise.set(
        gradeKeyString({
          kind: 'pairwise',
          candidate: variant.name,
          caseId: compared.id,
        }),
        compared.preferences
      );
  return { runId, trials, pairwise, comparable };
}

/** What a resumed grading has to grade: the keys without a verdict, and their cases. */
export interface GradingToResume {
  trials: number;
  comparisons: number;
  cases: Set<string>;
}

/**
 * The trials and comparisons of a stored run that `previous` has no verdict
 * for. `trials` are the run's trials by variant and case, each with whether
 * its client failed (then nothing grades it); `pairwise` names the baseline
 * and the pairwise judges, when the eval has any.
 */
export function gradingToResume(
  previous: PreviousGrades,
  trials: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyArray<{ clientFailed: boolean }>>
  >,
  pairwise?: { baseline: string; judges: readonly string[] }
): GradingToResume {
  const todo: GradingToResume = { trials: 0, comparisons: 0, cases: new Set() };
  for (const [variant, byCase] of trials)
    for (const [caseId, list] of byCase)
      for (const [trial, { clientFailed }] of list.entries()) {
        if (clientFailed) continue;
        const stored = previous.trials.get(
          gradeKeyString({ kind: 'trial', variant, caseId, trial })
        );
        if (stored && trialGradeComplete(stored)) continue;
        todo.trials++;
        todo.cases.add(caseId);
      }
  if (pairwise?.judges.length) {
    const baseline = previous.comparable.get(pairwise.baseline);
    for (const [candidate, cases] of previous.comparable) {
      if (candidate === pairwise.baseline || !baseline) continue;
      for (const caseId of cases) {
        if (!baseline.has(caseId)) continue;
        const stored = previous.pairwise.get(
          gradeKeyString({ kind: 'pairwise', candidate, caseId })
        );
        if (pairwiseJudgesToRun(pairwise.judges, stored).length === 0) continue;
        todo.comparisons++;
        todo.cases.add(caseId);
      }
    }
  }
  return todo;
}

/** Whether a score, or one of its judges, has no verdict: its grader failed to run. */
function failedToRun(score: GraderScore): boolean {
  return (
    score.error !== undefined || (score.judgeResults ?? []).some(failedToRun)
  );
}

/** Whether every grader and judge of a trial gave a verdict. */
export function trialGradeComplete(outcome: GradingOutcome): boolean {
  return !Object.values(outcome.scores).some(
    (score) => score !== undefined && failedToRun(score)
  );
}

/** The judges among `judges` without a preference in `previous`: they failed to run, or never ran. */
function pairwiseJudgesToRun(
  judges: readonly string[],
  previous: readonly PairwiseCasePreference[] | undefined
): string[] {
  return judges.filter(
    (judge) =>
      !previous?.some(
        (preference) =>
          preference.judge === judge && preference.error === undefined
      )
  );
}

/** How much of a resumed grading was reused, and how much graded again. */
export interface ResumeCounts {
  /** Trials whose every judge result was reused. */
  reusedTrials: number;
  /** Trials with a judge (or every grader) graded again. */
  gradedTrials: number;
  /** Cases whose every pairwise preference was reused. */
  reusedComparisons: number;
  /** Cases with a pairwise judge run again. */
  gradedComparisons: number;
}

/**
 * `mst grade --resume`: grading that keeps every verdict `previous` holds and
 * grades only what has none, through `inner` (here, or on grade shards).
 *
 * A trial whose judges all gave a verdict is graded here with them reused:
 * its assertions are cheap and run again, and no judge runs. Any other trial
 * goes to `inner`, whose grading reuses the judges that gave one. A case's
 * pairwise preferences are reused judge by judge, and `inner` runs the rest.
 */
export function resumedGrading(
  previous: PreviousGrades,
  inner: GradingSource
): GradingSource & { readonly counts: ResumeCounts } {
  const counts: ResumeCounts = {
    reusedTrials: 0,
    gradedTrials: 0,
    reusedComparisons: 0,
    gradedComparisons: 0,
  };
  return {
    judgesRunHere: inner.judgesRunHere,
    counts,
    async trial(key, grade) {
      const stored = previous.trials.get(gradeKeyString(key));
      if (stored && trialGradeComplete(stored)) {
        counts.reusedTrials++;
        return grade(stored);
      }
      counts.gradedTrials++;
      const outcome = await inner.trial(key, (given) => grade(given ?? stored));
      // Grading that didn't come back (a lost grade shard) keeps the
      // verdicts it had, for the next resume to reuse.
      const lost = outcome.scores.error;
      return stored && lost && Object.keys(outcome.scores).length === 1
        ? { ...stored, scores: { ...stored.scores, error: lost } }
        : outcome;
    },
    async pairwise(key, judges, judge) {
      const stored = previous.pairwise.get(gradeKeyString(key));
      const toRun = pairwiseJudgesToRun(judges, stored);
      const fresh =
        toRun.length === 0
          ? []
          : await inner.pairwise(key, toRun, (only) => judge(only ?? toRun));
      if (toRun.length === 0) counts.reusedComparisons++;
      else counts.gradedComparisons++;
      // In the judges' order: each judge's new preference, else its stored one.
      return judges.map(
        (name) =>
          fresh.find((preference) => preference.judge === name) ??
          stored?.find((preference) => preference.judge === name) ?? {
            judge: name,
            error: `Missing: no preference came back for ${name}.`,
          }
      );
    },
  };
}
