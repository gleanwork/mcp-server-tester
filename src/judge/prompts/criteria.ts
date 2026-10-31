/**
 * The `criteria` judge's question about one criterion (ADR 0009). The
 * criterion is the case's; this wraps it, and the judge sends it with the
 * shared prompt in `question.ts`. Any change here changes the judge's
 * version, so its calibrations go stale.
 */

/** Where a criterion's text goes in the question. */
const CRITERION_PLACEHOLDER = '{criterion}';

export const CRITERION_QUESTION = `Does the assistant's work meet this criterion?

Criterion: ${CRITERION_PLACEHOLDER}

Judge only this criterion, whatever else the work does well or badly. A criterion about the final answer is met when the answer does what it says; one about what the assistant did is met when the trace shows it. When there is a reference answer, use it as what a right answer says.`;

/** The question for one criterion. */
export function criterionQuestion(text: string): string {
  return CRITERION_QUESTION.replace(CRITERION_PLACEHOLDER, () => text);
}
