/**
 * The built-in `rubric` judge: an LLM scores the response against a rubric.
 *
 * It is a judge like any plugin judge. `{ rubric, provider, model, ... }` on
 * an assertion is shorthand for `{ judge: 'rubric', options: { ... } }`.
 */
import { z } from 'zod';
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { createJudge, preflightJudge } from './judgeClient.js';
import { DEFAULT_JUDGE_PROVIDER, JUDGE_PROVIDER_KINDS } from './judgeTypes.js';
import {
  BUILT_IN_RUBRICS,
  resolveRubric,
  type BuiltInRubric,
} from './rubrics.js';

const BUILT_IN_RUBRIC_NAMES = Object.keys(BUILT_IN_RUBRICS) as [
  BuiltInRubric,
  ...BuiltInRubric[],
];

/** A built-in rubric name, or custom rubric text. */
export const RubricSpecSchema = z.union([
  z.enum(BUILT_IN_RUBRIC_NAMES),
  z.object({ text: z.string().min(1) }),
]);

/** The rubric judge's LLM settings, which an assertion may also set flat. */
export const RubricJudgeLLMSchema = z.object({
  provider: z.enum(JUDGE_PROVIDER_KINDS).optional(),
  model: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  maxToolOutputSize: z.number().int().positive().optional(),
});

const RubricJudgeOptionsSchema = RubricJudgeLLMSchema.extend({
  rubric: RubricSpecSchema,
}).strict();

export const RUBRIC_JUDGE: JudgeDefinition = {
  schema: RubricJudgeOptionsSchema,
  async evaluate({ case: evalCase, trial }, options) {
    const { rubric, ...config } = RubricJudgeOptionsSchema.parse(options);
    const result = await createJudge(config).evaluate(
      trial.response,
      evalCase.expected.answer ?? null,
      resolveRubric(rubric)
    );
    return {
      score: result.score ?? (result.pass ? 1 : 0),
      reasoning: result.reasoning,
      provider: config.provider ?? DEFAULT_JUDGE_PROVIDER,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  },
  async preflight(options) {
    const { rubric: _rubric, ...config } =
      RubricJudgeOptionsSchema.parse(options);
    await preflightJudge(config);
  },
};
