/**
 * The built-in `criteria` judge (ADR 0009): a case lists its own criteria
 * in its `judges` entry, and the judge checks each one in its own model
 * call. The case passes when every required criterion passes. Each
 * criterion is its own label question, `criteria#<id>`, with an identity
 * that covers only it, so the same criterion in several cases is labeled
 * and calibrated once.
 */
import { z } from 'zod';
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { CRITERION_QUESTION, criterionQuestion } from './prompts/criteria.js';
import { defineQuestionJudge } from './questionJudge.js';

/** A criterion's ID: its label question is `criteria#<id>`. */
const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const CriterionSchema = z
  .object({
    id: z
      .string()
      .regex(
        CRITERION_ID,
        'a criterion id is letters, digits, "_", "." and "-", and starts with a letter or digit'
      ),
    text: z.string().trim().min(1),
    /** A criterion that isn't required is reported but doesn't decide the pass. */
    required: z.boolean().optional(),
  })
  .strict();

const CriteriaSchema = z
  .array(CriterionSchema)
  .min(1)
  .superRefine((criteria, context) => {
    const seen = new Set<string>();
    for (const [index, { id }] of criteria.entries()) {
      if (seen.has(id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `criterion "${id}" is listed twice`,
        });
      seen.add(id);
    }
  });

export const CRITERIA_JUDGE: JudgeDefinition = defineQuestionJudge({
  description:
    "Checks each of the case's own criteria in its own model call: yes, no or unknown. The case passes when every required criterion passes; each criterion is labeled and calibrated as criteria#<id>.",
  prompts: { question: CRITERION_QUESTION },
  options: { criteria: CriteriaSchema },
  reference: true,
  // A criterion can be about the answer alone, so the judge asks even when
  // the client didn't report its calls.
  needsTrace: false,
  criteria: true,
  questions: (_input, options) =>
    options.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterionQuestion(criterion.text),
      labelText: criterion.text,
      ...(criterion.required === false ? { required: false } : {}),
    })),
  // A criterion's verdict depends on its id and text, not on `required`,
  // which only says whether it decides the case.
  criterionOptions: (options, id) => ({
    ...options,
    criteria: Array.isArray(options.criteria)
      ? options.criteria
          .filter(
            (criterion: unknown) =>
              (criterion as { id?: unknown } | null)?.id === id
          )
          .map((criterion: unknown) => {
            const { id, text } = criterion as { id?: unknown; text?: unknown };
            return { id, text };
          })
      : options.criteria,
  }),
});
