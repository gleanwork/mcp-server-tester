/**
 * The built-in `rubric` judge: an LLM scores the response against a rubric.
 *
 * It is a judge like any plugin judge. `{ rubric, provider, model, ... }` on
 * an assertion is shorthand for `{ judge: 'rubric', options: { ... } }`.
 */
import { z } from 'zod';
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_MODELS,
  DEFAULT_JUDGE_TEMPERATURE,
} from './adapterSupport.js';
import { createJudge, preflightJudge } from './judgeClient.js';
import { contentHash } from './judgeIdentity.js';
import { DEFAULT_JUDGE_PROVIDER, JudgeLLMSchema } from './judgeTypes.js';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from './llmJudge.js';
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

const RubricJudgeOptionsSchema = JudgeLLMSchema.extend({
  rubric: RubricSpecSchema,
}).strict();

/**
 * The rubric judge's version: what decides its verdict besides its options.
 * Its prompts, every built-in rubric's text and the defaults it falls back
 * on, so a change to any of them makes it a different judge. A change to
 * one rubric changes the version for all of them, which is coarser than it
 * needs to be but never misses a change.
 */
const RUBRIC_JUDGE_VERSION = contentHash({
  system: JUDGE_SYSTEM_PROMPT,
  prompt: buildJudgePrompt('{candidate}', '{reference}', '{rubric}'),
  promptWithoutReference: buildJudgePrompt('{candidate}', null, '{rubric}'),
  rubrics: BUILT_IN_RUBRICS,
  defaults: {
    provider: DEFAULT_JUDGE_PROVIDER,
    models: DEFAULT_JUDGE_MODELS,
    maxTokens: DEFAULT_JUDGE_MAX_TOKENS,
    temperature: DEFAULT_JUDGE_TEMPERATURE,
  },
});

export const RUBRIC_JUDGE: JudgeDefinition = {
  description:
    "An LLM grades the answer against a rubric: a built-in one or your own text, with the case's expected answer as reference.",
  schema: RubricJudgeOptionsSchema,
  version: RUBRIC_JUDGE_VERSION,
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
