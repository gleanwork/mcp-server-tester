/**
 * Yes-or-no judges (ADR 0009): a judge asks one question per model call
 * about the trial's trace, and each answer is yes, no or unknown. A judge
 * that checks several things asks several questions, and combines them:
 * any required "no" fails the trial; otherwise any required "unknown"
 * makes the verdict unknown; otherwise it passes.
 *
 * `defineQuestionJudge` turns a judge's questions into a judge definition,
 * with the LLM settings every built-in judge takes and a version that
 * covers its prompts, the trace format and the defaults it falls back on.
 */
import type { z } from 'zod';
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_MODELS,
  DEFAULT_JUDGE_TEMPERATURE,
} from './adapterSupport.js';
import {
  missingRequirement,
  type JudgeInput,
  type JudgeScore,
  type JudgeSubScore,
} from './judgeContract.js';
import { createJudgeCompletion, preflightJudge } from './judgeClient.js';
import { contentHash } from './judgeIdentity.js';
import {
  DEFAULT_JUDGE_PROVIDER,
  JudgeLLMSchema,
  type JudgeConfig,
  type UsageMetrics,
} from './judgeTypes.js';
import {
  embeddedJsonObjects,
  type JudgeCompletionAdapter,
} from './llmJudge.js';
import {
  DEFAULT_TRACE_OUTPUT_BYTES,
  renderJudgeTrace,
  traceRecorded,
} from './judgeTrace.js';
import { QUESTION_SYSTEM_PROMPT, questionPrompt } from './prompts/question.js';

export type QuestionVerdict = 'yes' | 'no' | 'unknown';

/** A criterion's verdict, as labels give it, for each answer. */
const VERDICT_LABELS = {
  yes: 'pass',
  no: 'fail',
  unknown: 'unknown',
} as const satisfies Record<QuestionVerdict, string>;

/** One question a judge asks about a trial. */
interface JudgeQuestion {
  /** Names the answer in results, such as a criterion's ID. */
  id: string;
  text: string;
  /** A required question decides the verdict. @default true */
  required?: boolean;
  /**
   * For a judge that reports criteria: what a person labeling this one
   * answers, when it isn't `text` (the criterion as the case wrote it).
   */
  labelText?: string;
}

/** A model's answer to one question. */
interface QuestionAnswer {
  verdict: QuestionVerdict;
  reasoning: string;
  usage: Partial<UsageMetrics>;
}

/**
 * The shape of a judge's answer: `{"reasoning": "...", "<key>": "<choice>"}`,
 * where the choice is one of `choices`, in any case.
 */
export interface JudgeAnswerShape<Choice extends string> {
  key: string;
  choices: readonly Choice[];
}

/** A judge's answer as read: its choice, as `choices` spells it. */
export interface JudgeAnswer<Choice extends string> {
  choice: Choice;
  reasoning: string;
}

const VERDICT_ANSWER: JudgeAnswerShape<QuestionVerdict> = {
  key: 'verdict',
  choices: ['yes', 'no', 'unknown'],
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The shape's choice for `value`, compared without case. */
function choiceOf<Choice extends string>(
  shape: JudgeAnswerShape<Choice>,
  value: unknown
): Choice | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return shape.choices.find((choice) => choice.toLowerCase() === lower);
}

/**
 * A model sometimes quotes words in its reasoning without escaping the
 * quotes, so its answer isn't JSON, though its choice is plain. This reads
 * an answer that is exactly the two fields, in either order, with one
 * `"<key>":` in all its text and nothing shaped like a key (`"name":`)
 * in its reasoning. Anything else isn't read: a second `"<key>":` may be
 * the reasoning quoting one, or a second object; a key in the reasoning may
 * be another field, or quoted JSON with a choice of its own; and the
 * choice must be the model's own.
 */
function malformedAnswer<Choice extends string>(
  text: string,
  shape: JudgeAnswerShape<Choice>
): JudgeAnswer<Choice> | null {
  const key = escapeRegExp(shape.key);
  const choices = shape.choices.map(escapeRegExp).join('|');
  if ((text.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length !== 1)
    return null;
  const first = new RegExp(
    `^\\{\\s*"reasoning"\\s*:\\s*"([\\s\\S]*)"\\s*,\\s*"${key}"\\s*:\\s*"(${choices})"\\s*\\}$`,
    'i'
  ).exec(text);
  const last = first
    ? null
    : new RegExp(
        `^\\{\\s*"${key}"\\s*:\\s*"(${choices})"\\s*,\\s*"reasoning"\\s*:\\s*"([\\s\\S]*)"\\s*\\}$`,
        'i'
      ).exec(text);
  const answer = first
    ? { reasoning: first[1]!, choice: first[2]! }
    : last
      ? { choice: last[1]!, reasoning: last[2]! }
      : null;
  if (!answer || /"[^"\s]+"\s*:/.test(answer.reasoning)) return null;
  const choice = choiceOf(shape, answer.choice);
  return choice === undefined ? null : { choice, reasoning: answer.reasoning };
}

/** A yes-or-no judge's answer (see `parseJudgeAnswer`). */
export function parseQuestionAnswer(
  text: string,
  truncated = false
): { verdict: QuestionVerdict; reasoning: string } {
  const { choice, reasoning } = parseJudgeAnswer(
    text,
    VERDICT_ANSWER,
    truncated
  );
  return { verdict: choice, reasoning };
}

/**
 * Reads a model's answer: the JSON object itself, or the last one in the
 * text that has the answer's shape (models sometimes reason first), or one
 * whose reasoning has unescaped quotes (`malformedAnswer`).
 */
export function parseJudgeAnswer<Choice extends string>(
  text: string,
  shape: JudgeAnswerShape<Choice>,
  truncated = false
): JudgeAnswer<Choice> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let candidates: unknown[];
  let json = true;
  try {
    candidates = [JSON.parse(cleaned)];
  } catch {
    json = false;
    candidates = embeddedJsonObjects(cleaned).reverse();
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const fields = candidate as Record<string, unknown>;
    const choice = choiceOf(shape, fields[shape.key]);
    if (choice !== undefined && typeof fields.reasoning === 'string')
      return { choice, reasoning: fields.reasoning };
  }
  // Valid JSON was the model's answer, right or wrong, and a cut-off answer
  // has no choice of its own yet.
  const malformed = json || truncated ? null : malformedAnswer(cleaned, shape);
  if (malformed) return malformed;
  throw new Error(
    truncated
      ? `The judge's answer was cut off at its token limit before its JSON was complete; raise the judge's maxTokens. Answer: ${text}`
      : `The judge's answer isn't {"reasoning", "${shape.key}": ${shape.choices.map((c) => `"${c}"`).join(' | ')}}: ${text.slice(0, 500)}`
  );
}

/** Asks one question about a rendered trace: one model call. */
/**
 * How many times a question is asked again when its answer can't be read.
 * A model that writes JSON into its reasoning without escaping it (a tool
 * call's arguments, say) usually writes valid JSON the next time. A
 * cut-off answer isn't asked again: the same token limit would cut it off
 * again. Part of the judge's version.
 */
export const UNREADABLE_ANSWER_RETRIES = 1;

async function askJudgeQuestion(
  complete: JudgeCompletionAdapter,
  trace: string,
  question: string
): Promise<QuestionAnswer> {
  const { choice, ...answer } = await askJudge(
    complete,
    { system: QUESTION_SYSTEM_PROMPT, prompt: questionPrompt(trace, question) },
    VERDICT_ANSWER
  );
  return { verdict: choice, ...answer };
}

/**
 * One model call, read as an answer of `shape`. An answer that can't be
 * read is asked again, up to `UNREADABLE_ANSWER_RETRIES` times, unless it
 * was cut off. Usage covers every attempt.
 */
export async function askJudge<Choice extends string>(
  complete: JudgeCompletionAdapter,
  request: { system: string; prompt: string },
  shape: JudgeAnswerShape<Choice>
): Promise<JudgeAnswer<Choice> & { usage: Partial<UsageMetrics> }> {
  const started = Date.now();
  const usage: Partial<UsageMetrics>[] = [];
  for (let attempt = 0; ; attempt++) {
    const completion = await complete(request);
    usage.push(
      Object.fromEntries(
        Object.entries(completion.usage ?? {}).filter(
          ([, v]) => v !== undefined
        )
      ) as Partial<UsageMetrics>
    );
    const truncated = completion.truncated === true;
    let answer: JudgeAnswer<Choice>;
    try {
      answer = parseJudgeAnswer(completion.text, shape, truncated);
    } catch (error) {
      if (truncated || attempt >= UNREADABLE_ANSWER_RETRIES) throw error;
      continue;
    }
    return {
      ...answer,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        durationMs: Date.now() - started,
        ...sumUsage(usage.map((u) => ({ usage: u }))),
      },
    };
  }
}

/** One question with its answer. */
export interface AnsweredQuestion extends QuestionAnswer {
  question: JudgeQuestion;
}

function sumUsage(
  answers: readonly { usage: Partial<UsageMetrics> }[]
): Partial<UsageMetrics> {
  const total: Record<string, number> = {};
  for (const { usage } of answers)
    for (const [key, value] of Object.entries(usage))
      if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  return total as Partial<UsageMetrics>;
}

/**
 * The verdict a judge's answers give: a required "no" fails; otherwise a
 * required "unknown" makes it unknown; otherwise it passes. Each answer is
 * kept in `metadata.questions`; the answered ones are also sub-scores.
 */
export function combineAnswers(
  answers: readonly AnsweredQuestion[]
): JudgeScore {
  const required = answers.filter((a) => a.question.required !== false);
  const failed = required.filter((a) => a.verdict === 'no');
  const unknown = required.filter((a) => a.verdict === 'unknown');
  const deciding = failed.length ? failed : unknown.length ? unknown : answers;
  const single = answers.length === 1;
  const reasoning = deciding
    .map((a) => (single ? a.reasoning : `${a.question.id}: ${a.reasoning}`))
    .join('\n');
  const subScores: Record<string, JudgeSubScore> = {};
  for (const a of answers)
    if (a.verdict !== 'unknown')
      subScores[a.question.id] = {
        score: a.verdict === 'yes' ? 1 : 0,
        pass: a.verdict === 'yes',
        reasoning: a.reasoning,
      };
  const metadata = {
    questions: answers.map((a) => ({
      id: a.question.id,
      verdict: a.verdict,
      ...(a.question.required === false ? { required: false } : {}),
      reasoning: a.reasoning,
    })),
  };
  const usage = sumUsage(answers);
  if (failed.length)
    return { score: 0, pass: false, reasoning, subScores, metadata, usage };
  if (unknown.length)
    return { score: 0, unknown: true, reasoning, subScores, metadata, usage };
  return { score: 1, pass: true, reasoning, subScores, metadata, usage };
}

type JudgeLLMOptions = z.infer<typeof JudgeLLMSchema>;

const SAMPLE_EVENTS: JudgeInput['trial']['events'] = [
  {
    kind: 'tool_call',
    source: 'mcp',
    name: '{tool}',
    server: '{server}',
    arguments: { '{argument}': '{value}' },
    output: '{result}',
    isError: true,
  },
  {
    kind: 'tool_call',
    source: 'mcp',
    name: '{write}',
    output: '{result}',
    simulatedWrite: true,
  },
  { kind: 'tool_call', source: 'builtin', name: '{unrecorded result}' },
  {
    kind: 'tool_search',
    source: 'builtin',
    name: '{search}',
    results: [{ name: '{found}', server: '{server}' }, { name: '{found}' }],
  },
  { kind: 'skill', source: 'builtin', name: '{skill}' },
];

/** A trial for the version's sample traces. */
function sampleInput(trial: Partial<JudgeInput['trial']>): JudgeInput {
  return {
    case: {
      input: { prompt: '{request}' },
      expected: { answer: '{reference}' },
      tags: [],
      metadata: {},
    },
    trial: {
      response: '{answer}',
      text: '{answer}',
      events: SAMPLE_EVENTS,
      evidence: 'structured',
      ...trial,
    },
  };
}

/**
 * Traces that reach every part of the trace format (each evidence level,
 * empty traces, a cut result), so a change to how traces render changes the
 * version.
 */
export function sampleTraces(reference: boolean | undefined): string[] {
  const options = { reference };
  return [
    renderJudgeTrace(sampleInput({}), options),
    renderJudgeTrace(sampleInput({ events: [] }), options),
    renderJudgeTrace(sampleInput({ evidence: 'observed' }), options),
    renderJudgeTrace(
      sampleInput({ evidence: 'observed', events: [] }),
      options
    ),
    renderJudgeTrace(sampleInput({ evidence: 'none', events: [] }), options),
    renderJudgeTrace(sampleInput({ evidence: undefined, events: [] }), options),
    renderJudgeTrace(
      sampleInput({
        events: [
          {
            kind: 'tool_call',
            source: 'mcp',
            name: '{tool}',
            output: '{long result}',
          },
        ],
      }),
      { ...options, maxToolOutputSize: 4 }
    ),
  ];
}

export interface QuestionJudgeSpec<Options extends z.ZodRawShape> {
  description: string;
  /**
   * The judge's prompt text, as written in its prompt file. It is part of
   * the judge's version, with the shared question prompt and trace format.
   */
  prompts: Readonly<Record<string, string>>;
  /** Options the judge takes besides the LLM settings. */
  options?: Options;
  /** Paths in the judge input the judge needs (see `JudgeDefinition.requires`). */
  requires?: readonly string[];
  /** Show the case's reference answer in the trace. @default false */
  reference?: boolean;
  /**
   * The questions need the tool calls. When the client didn't report them
   * (evidence `none`), the judge answers unknown without a model call.
   * @default true
   */
  needsTrace?: boolean;
  /**
   * Each question is a criterion a person labels on its own: the score lists
   * each one's verdict as `criteria`, so it is its own label question.
   */
  criteria?: boolean;
  /** The options that decide one criterion (see `JudgeDefinition.criterionOptions`). */
  criterionOptions?: JudgeDefinition['criterionOptions'];
  /** The questions to ask about one trial: one model call each. */
  questions: (
    input: JudgeInput,
    options: z.infer<z.ZodObject<Options>> & JudgeLLMOptions
  ) => JudgeQuestion[];
}

/**
 * The questions a judge asks of the sample with its default options, and
 * whether each is required, for its version. A judge whose questions come
 * from the case (criteria) asks none of the sample, and one whose `requires`
 * the sample doesn't meet isn't asked: evaluate() never calls `questions`
 * on such an input.
 */
function sampleQuestions<Options extends z.ZodRawShape>(
  spec: QuestionJudgeSpec<Options>,
  schema: z.ZodType
): Array<{ id: string; text: string; required: boolean }> | null {
  const sample = sampleInput({});
  const defaults = schema.safeParse({});
  if (!defaults.success || missingRequirement(sample, spec.requires))
    return null;
  try {
    return spec
      .questions(
        sample,
        defaults.data as z.infer<z.ZodObject<Options>> & JudgeLLMOptions
      )
      .map(({ id, text, required }) => ({
        id,
        text,
        required: required !== false,
      }));
  } catch {
    // The questions don't suit the sample; their text is in `prompts`.
    return null;
  }
}

/** The model settings among a built-in judge's options. */
export function judgeLLMConfig(options: JudgeLLMOptions): JudgeConfig {
  const { maxToolOutputSize: _size, ...config } = JudgeLLMSchema.parse(
    Object.fromEntries(
      Object.keys(JudgeLLMSchema.shape)
        .filter((key) => key in options)
        .map((key) => [key, options[key as keyof JudgeLLMOptions]])
    )
  );
  return config;
}

/** The defaults a built-in judge falls back on, for its version. */
export const JUDGE_DEFAULTS = {
  provider: DEFAULT_JUDGE_PROVIDER,
  models: DEFAULT_JUDGE_MODELS,
  maxTokens: DEFAULT_JUDGE_MAX_TOKENS,
  temperature: DEFAULT_JUDGE_TEMPERATURE,
  maxToolOutputSize: DEFAULT_TRACE_OUTPUT_BYTES,
};

/** A yes-or-no judge from its questions. */
export function defineQuestionJudge<
  Options extends z.ZodRawShape = Record<never, never>,
>(spec: QuestionJudgeSpec<Options>): JudgeDefinition {
  const schema = JudgeLLMSchema.extend(
    spec.options ?? ({} as Options)
  ).strict();
  const version = contentHash({
    system: QUESTION_SYSTEM_PROMPT,
    prompt: questionPrompt('{trace}', '{question}'),
    traces: sampleTraces(spec.reference),
    prompts: spec.prompts,
    questions: sampleQuestions(spec, schema),
    needsTrace: spec.needsTrace !== false,
    unreadableAnswerRetries: UNREADABLE_ANSWER_RETRIES,
    defaults: JUDGE_DEFAULTS,
  });
  return {
    description: spec.description,
    schema,
    version,
    ...(spec.requires !== undefined ? { requires: spec.requires } : {}),
    ...(spec.criterionOptions !== undefined
      ? { criterionOptions: spec.criterionOptions }
      : {}),
    async evaluate(input, rawOptions) {
      const options = schema.parse(rawOptions) as z.infer<
        z.ZodObject<Options>
      > &
        JudgeLLMOptions;
      const config = judgeLLMConfig(options);
      const questions = spec.questions(input, options);
      if (questions.length === 0)
        return { score: 0, skipped: true, reasoning: 'no questions to ask' };
      if (spec.needsTrace !== false && !traceRecorded(input.trial))
        return {
          score: 0,
          unknown: true,
          reasoning:
            "The client didn't report its tool calls, so the trace can't answer this judge's questions.",
        };
      const complete = createJudgeCompletion(config);
      const trace = renderJudgeTrace(input, {
        reference: spec.reference,
        ...(options.maxToolOutputSize !== undefined
          ? { maxToolOutputSize: options.maxToolOutputSize }
          : {}),
      });
      const answers = await Promise.all(
        questions.map(async (question) => ({
          question,
          ...(await askJudgeQuestion(complete, trace, question.text)),
        }))
      );
      const provider = config.provider ?? DEFAULT_JUDGE_PROVIDER;
      const combined = combineAnswers(answers);
      // A judge that reports criteria lists its answers there; one rep's
      // `metadata.questions` would contradict their majority over reps.
      const { metadata: _questions, ...withoutQuestions } = combined;
      return {
        ...(spec.criteria ? withoutQuestions : combined),
        ...(spec.criteria
          ? {
              criteria: answers.map((a) => ({
                id: a.question.id,
                text: a.question.labelText ?? a.question.text,
                ...(a.question.required === false ? { required: false } : {}),
                verdict: VERDICT_LABELS[a.verdict],
                reasoning: a.reasoning,
              })),
            }
          : {}),
        provider,
        model: config.model ?? DEFAULT_JUDGE_MODELS[provider],
      };
    },
    async preflight(rawOptions) {
      await preflightJudge(
        judgeLLMConfig(schema.parse(rawOptions) as JudgeLLMOptions)
      );
    },
  };
}
