/**
 * Built-in judge rubrics matching Glean EvalV2's named judge types.
 * Use these for consistent, standardized evaluations across teams.
 *
 * All built-in rubrics use a 5-point scale: 0.0 / 0.25 / 0.5 / 0.75 / 1.0
 */
export type BuiltInRubric =
  | 'correctness'
  | 'completeness'
  | 'groundedness'
  | 'instruction-following'
  | 'conciseness';

export const BUILT_IN_RUBRICS: Record<BuiltInRubric, string> = {
  correctness:
    'Evaluate whether the response is factually correct and accurately answers the question. ' +
    'Compare against the reference answer if provided. ' +
    'Score 1.0 for fully correct with no errors; ' +
    'Score 0.75 for mostly correct with one minor inaccuracy or omission; ' +
    'Score 0.5 for partially correct — answers part of the question but misses key elements; ' +
    'Score 0.25 for minimally relevant but substantially incorrect or missing most key details; ' +
    'Score 0.0 for incorrect, irrelevant, or directly contradicting the reference.',

  completeness:
    'Evaluate whether the response fully addresses all aspects of the question. ' +
    'Score 1.0 if the response covers all key points comprehensively; ' +
    'Score 0.75 if the response covers most key points with one minor gap; ' +
    'Score 0.5 if the response partially answers — covers some aspects but misses others; ' +
    'Score 0.25 if the response touches on the topic but misses most key aspects; ' +
    'Score 0.0 if major aspects of the question are entirely missing or the response is off-topic.',

  groundedness:
    'Evaluate whether all claims in the response are supported by the retrieved context or reference. ' +
    'Penalize unsupported assertions or hallucinated facts. ' +
    'Score 1.0 for fully grounded — every claim is traceable to the provided context; ' +
    'Score 0.75 for mostly grounded with one minor unsupported detail; ' +
    'Score 0.5 for partially grounded — some claims are supported but notable hallucinations are present; ' +
    'Score 0.25 for minimally grounded — most claims are unsupported or invented; ' +
    'Score 0.0 for completely hallucinated or contradicting the provided context.',

  'instruction-following':
    'Evaluate whether the response follows the instructions given in the question. ' +
    'Check format, tone, constraints, and task completion. ' +
    'Score 1.0 for full compliance — all instructions are followed precisely; ' +
    'Score 0.75 for mostly compliant with one minor deviation from the instructions; ' +
    'Score 0.5 for partial compliance — some instructions followed but key constraints violated; ' +
    'Score 0.25 for minimal compliance — the response loosely addresses the task but ignores most instructions; ' +
    'Score 0.0 for non-compliance — the response disregards the instructions entirely.',

  conciseness:
    'Evaluate whether the response is appropriately concise without losing important information. ' +
    'Penalize unnecessary verbosity, padding, or repetition. ' +
    'Score 1.0 for well-sized — concise and complete with no unnecessary content; ' +
    'Score 0.75 for slightly verbose but no information is lost or repeated; ' +
    'Score 0.5 for moderately verbose — some padding or repetition that reduces clarity; ' +
    'Score 0.25 for excessively verbose — significantly overlong with substantial filler or repetition; ' +
    'Score 0.0 for extremely verbose — so padded or repetitive that the core answer is obscured.',
};

/** A rubric specification: either a built-in named rubric or custom text. */
export type RubricSpec = BuiltInRubric | { text: string };

/**
 * Returns true if `s` is a built-in rubric name.
 */
export function isBuiltInRubric(s: unknown): s is BuiltInRubric {
  return typeof s === 'string' && s in BUILT_IN_RUBRICS;
}

/**
 * Resolves a RubricSpec to its full rubric text.
 * - Built-in name → returns the expanded rubric text from BUILT_IN_RUBRICS
 * - Custom object → returns rubric.text as-is
 */
export function resolveRubric(rubric: RubricSpec): string {
  if (typeof rubric === 'string') {
    return BUILT_IN_RUBRICS[rubric];
  }
  return rubric.text;
}
