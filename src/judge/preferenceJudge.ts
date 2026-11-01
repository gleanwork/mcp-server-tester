/**
 * The built-in `preference` pairwise judge (ADR 0009): which of two trials
 * of one case better did what the user asked? It answers A, B or tie in
 * one model call. MST asks again with the trials swapped
 * (`swapPositions`) and reconciles the two answers, so the order the
 * trials are shown in can't decide the preference.
 */
import { z } from 'zod';
import type {
  PairwiseJudgeDefinition,
  PreferredSide,
} from './pairwiseContract.js';
import { createJudgeCompletion, preflightJudge } from './judgeClient.js';
import { contentHash } from './judgeIdentity.js';
import { DEFAULT_JUDGE_MODELS } from './adapterSupport.js';
import { DEFAULT_JUDGE_PROVIDER, JudgeLLMSchema } from './judgeTypes.js';
import { renderJudgePair, type JudgeTraceOptions } from './judgeTrace.js';
import {
  askJudge,
  JUDGE_DEFAULTS,
  judgeLLMConfig,
  sampleTraces,
  UNREADABLE_ANSWER_RETRIES,
  type JudgeAnswerShape,
} from './questionJudge.js';
import {
  PREFERENCE_SYSTEM_PROMPT,
  preferencePrompt,
} from './prompts/preference.js';

type Choice = 'A' | 'B' | 'tie';

const PREFERENCE_ANSWER: JudgeAnswerShape<Choice> = {
  key: 'preference',
  choices: ['A', 'B', 'tie'],
};

/** A is the baseline in the order `compare` is called with. */
const SIDES: Record<Choice, PreferredSide> = {
  A: 'baseline',
  B: 'candidate',
  tie: 'tie',
};

const PreferenceOptionsSchema = JudgeLLMSchema.extend({
  /** Show the case's reference answer, when it has one. @default true */
  reference: z.boolean().default(true),
}).strict();

/** A pair that reaches the parts of the format a single trace doesn't. */
function samplePair(options: JudgeTraceOptions): string {
  const trial = {
    response: '{answer}',
    text: '{answer}',
    events: [],
    evidence: 'structured' as const,
  };
  return renderJudgePair(
    {
      case: {
        input: { prompt: '{request}' },
        expected: { answer: '{reference}' },
        tags: [],
        metadata: {},
      },
      a: { ...trial, text: '{answer A}' },
      b: { ...trial, text: '{answer B}' },
    },
    options
  );
}

const VERSION = contentHash({
  system: PREFERENCE_SYSTEM_PROMPT,
  prompt: preferencePrompt('{pair}'),
  traces: sampleTraces(true),
  pairs: [samplePair({ reference: true }), samplePair({ reference: false })],
  answer: PREFERENCE_ANSWER,
  sides: SIDES,
  swapPositions: true,
  unreadableAnswerRetries: UNREADABLE_ANSWER_RETRIES,
  defaults: { ...JUDGE_DEFAULTS, reference: true },
});

export const PREFERENCE_JUDGE: PairwiseJudgeDefinition = {
  description:
    "Asks which run better did what the user asked: the final answer first, then the tool use. A, B or tie, asked in both orders, with the case's reference answer when it has one.",
  schema: PreferenceOptionsSchema,
  version: VERSION,
  swapPositions: true,
  async preflight(rawOptions) {
    await preflightJudge(
      judgeLLMConfig(PreferenceOptionsSchema.parse(rawOptions))
    );
  },
  async compare(input, rawOptions) {
    const options = PreferenceOptionsSchema.parse(rawOptions);
    const config = judgeLLMConfig(options);
    const pair = renderJudgePair(
      { case: input.case, a: input.baseline, b: input.candidate },
      {
        reference: options.reference,
        ...(options.maxToolOutputSize !== undefined
          ? { maxToolOutputSize: options.maxToolOutputSize }
          : {}),
      }
    );
    const answer = await askJudge(
      createJudgeCompletion(config),
      { system: PREFERENCE_SYSTEM_PROMPT, prompt: preferencePrompt(pair) },
      PREFERENCE_ANSWER
    );
    const provider = config.provider ?? DEFAULT_JUDGE_PROVIDER;
    return {
      preference: SIDES[answer.choice],
      reasoning: answer.reasoning,
      usage: answer.usage,
      provider,
      model: config.model ?? DEFAULT_JUDGE_MODELS[provider],
      version: VERSION,
    };
  },
};
