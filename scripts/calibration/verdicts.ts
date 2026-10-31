/**
 * Whether a graded run has a verdict from each judge on every trace of the
 * calibration set. A judge that failed on a trace (its provider returned an
 * error, say) gave no verdict there, and numbers from part of the set
 * aren't the set's. An `unknown` answer is a verdict: `mst judges check`
 * counts it.
 */

/** One row of `mst label export --format jsonl`, as far as this reads it. */
export interface ExportedVerdict {
  judge: string;
  verdict?: string;
}

/** A sentence for each judge that has no verdict on some trace. */
export function missingVerdicts(
  rows: readonly ExportedVerdict[],
  judges: readonly string[],
  traces: number
): string[] {
  return judges.flatMap((judge) => {
    const judged = rows.filter(
      (row) => row.judge === judge && row.verdict !== undefined
    ).length;
    return judged < traces
      ? [`${judge} has verdicts on ${judged} of ${traces} traces`]
      : [];
  });
}
