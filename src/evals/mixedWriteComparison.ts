import type { EvalCaseResult } from '../types/reporter.js';
import type { WriteMode } from '../types/index.js';
import { isStoppedMode } from './writeModes.js';

export function mixedWriteComparisonSkipReason(
  baseline: EvalCaseResult,
  candidate: EvalCaseResult,
  baselineModes: Readonly<Record<string, WriteMode>> | undefined,
  candidateModes: Readonly<Record<string, WriteMode>> | undefined,
  requireModes: boolean
): string | undefined {
  if (!baselineModes || !candidateModes)
    return requireModes
      ? 'Mixed write modes: a variant has no recorded write modes.'
      : undefined;

  const modes = [baselineModes, candidateModes];
  const stopped = new Set(
    modes.flatMap((variantModes) =>
      Object.values(variantModes).filter(isStoppedMode)
    )
  );
  if (stopped.size < 2) return undefined;

  for (const [index, result] of [baseline, candidate].entries()) {
    const recordsWrites = Object.values(modes[index]!).some(isStoppedMode);
    const trials = result.trialResults ?? [result];
    if (trials.length === 0)
      return 'Mixed write modes: a variant has no trial evidence.';
    for (const trial of trials) {
      if (trial.error && !trial.gradingError)
        return 'Mixed write modes: a trial has incomplete evidence.';
      const record = trial.writeRecord;
      if (recordsWrites && !record)
        return 'Mixed write modes: a trial has no write record.';
      if (!record) continue;
      if (record.writes.length > 0 || record.unreported > 0)
        return 'Mixed write modes: a trial attempted a write.';
      if (
        record.unrecorded.length > 0 ||
        record.unclassified.length > 0 ||
        record.attribution !== 'exclusive'
      )
        return 'Mixed write modes: a trial has incomplete write evidence.';
    }
  }
  return undefined;
}
