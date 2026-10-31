/**
 * The verdicts a run's judges gave, and the key a label shares with the
 * verdict it labels (ADR 0009). Labels (`labels.ts`), `mst judges check`
 * and the report read verdicts through this module. It has no file or OS
 * access, so the report bundle can use it.
 */

import {
  type PAIRWISE_LABELS,
  type POINTWISE_LABELS,
  isInfraTrial,
  labelQuestion,
  type LabelRecord,
  type StoredRun,
} from './runFormat.js';
import type { GraderScore } from '../types/index.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';

type PointwiseLabel = (typeof POINTWISE_LABELS)[number];
type PairwiseLabel = (typeof PAIRWISE_LABELS)[number];

/** What a judge said: `unknown` when it couldn't decide (it skipped). */
type JudgeVerdict = PointwiseLabel | PairwiseLabel | 'unknown';

/** One verdict a judge gave in a run: what a label is compared with. */
export interface JudgedItem {
  judge: string;
  criterion?: string;
  variant: string;
  caseId: string;
  /** Pointwise: the trial's index, as in `traces/<variant>/<case-id>/<trial>.json`. */
  trial?: number;
  /** Pairwise: the variant this one was compared with. */
  baseline?: string;
  /** Absent when the judge failed to run. */
  verdict?: JudgeVerdict;
  judgeIdentity?: string;
  /** The judge has no version MST can see change. */
  judgeUnversioned?: true;
  judgeProvider?: string;
  judgeModel?: string;
  reasoning?: string;
  /** The case's input. */
  input?: string;
  /** The trial's final answer, when the run stores responses. */
  answer?: string;
}

function caseTrials(
  result: EvalCaseResult
): Array<{ trial: number; result: EvalCaseResult | TrialResult }> {
  return result.trialResults?.length
    ? result.trialResults.map((trial, index) => ({
        trial: index,
        result: trial,
      }))
    : [{ trial: 0, result }];
}

function judgeResults(score: GraderScore | undefined): GraderScore[] {
  if (!score) return [];
  return score.judgeResults?.length ? score.judgeResults : [score];
}

function pointwiseVerdict(score: GraderScore): JudgeVerdict | undefined {
  if (score.error !== undefined) return undefined;
  if (score.skipped) return 'unknown';
  return score.pass ? 'pass' : 'fail';
}

/**
 * Every verdict a run's judges gave: each pointwise judge's for each trial,
 * and each pairwise judge's for each case. Trials that failed on
 * infrastructure have no verdicts.
 */
export function judgedItems(stored: StoredRun): JudgedItem[] {
  const items: JudgedItem[] = [];
  for (const variant of stored.summary.variants) {
    for (const caseResult of variant.result?.caseResults ?? []) {
      const input = caseResult.request?.input;
      for (const { trial, result } of caseTrials(caseResult)) {
        // A trial the client couldn't run has no verdicts. One a grader
        // failed on keeps the other judges' verdicts.
        if (isInfraTrial(result) && result.gradingError === undefined) continue;
        const answer =
          'trace' in result && result.trace?.finalText !== undefined
            ? result.trace.finalText
            : undefined;
        for (const score of judgeResults(result.scores?.judge)) {
          if (score.judgeName === undefined) continue;
          const verdict = pointwiseVerdict(score);
          items.push({
            judge: score.judgeName,
            variant: variant.name,
            caseId: caseResult.id,
            trial,
            ...(verdict !== undefined ? { verdict } : {}),
            ...optional('judgeIdentity', score.judgeIdentity),
            ...optional('judgeUnversioned', score.judgeUnversioned),
            ...optional('judgeProvider', score.judgeProvider),
            ...optional('judgeModel', score.judgeModel),
            ...optional('reasoning', score.reasoning),
            ...optional('input', input),
            ...optional('answer', answer),
          });
        }
      }
    }
    const pairwise = variant.pairwise;
    if (!pairwise) continue;
    for (const comparison of pairwise.cases) {
      const caseResult = variant.result?.caseResults?.find(
        (result) => result.id === comparison.id
      );
      for (const preference of comparison.preferences) {
        const verdict: JudgeVerdict | undefined =
          preference.error !== undefined
            ? undefined
            : preference.skipped
              ? 'unknown'
              : preference.preference;
        items.push({
          judge: preference.judge,
          variant: variant.name,
          baseline: pairwise.baseline,
          caseId: comparison.id,
          ...(verdict !== undefined ? { verdict } : {}),
          ...optional('judgeProvider', preference.provider),
          ...optional('judgeModel', preference.model),
          ...optional('reasoning', preference.reasoning),
          ...optional('input', caseResult?.request?.input),
        });
      }
    }
  }
  return items;
}

/** `{ [key]: value }`, or nothing when the value is undefined. */
export function optional<K extends string, V>(
  key: K,
  value: V | undefined
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** What a label and the verdict it labels have in common. */
export type LabelKeyFields = Pick<
  JudgedItem,
  'judge' | 'criterion' | 'variant' | 'caseId' | 'trial' | 'baseline'
>;

/** A stored label's key fields. */
export function keyOf(label: LabelRecord): LabelKeyFields {
  return {
    judge: label.judge,
    ...optional('criterion', label.criterion),
    variant: label.variant,
    caseId: label.caseId,
    ...('trial' in label && typeof label.trial === 'number'
      ? { trial: label.trial }
      : {}),
    ...('baseline' in label && typeof label.baseline === 'string'
      ? { baseline: label.baseline }
      : {}),
  };
}

/** The key a label and the verdict it labels share. */
export function labelKey(item: LabelKeyFields | LabelRecord): string {
  const key = 'kind' in item ? keyOf(item) : item;
  return JSON.stringify([
    labelQuestion(key),
    key.variant,
    key.caseId,
    key.trial ?? null,
    key.baseline ?? null,
  ]);
}
