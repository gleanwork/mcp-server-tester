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
import { z } from 'zod';
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

/** One question a judge asks about a trial. */
interface JudgeQuestion {
  /** Names the answer in results, such as a criterion's ID. */
  id: string;
  text: string;
  /** A required question decides the verdict. @default true */
  required?: boolean;
}

/** A model's answer to one question. */
interface QuestionAnswer {
  verdict: QuestionVerdict;
  reasoning: string;
  usage: Partial<UsageMetrics>;
}

const AnswerSchema = z.object({
  verdict: z.enum(['yes', 'no', 'unknown']),
  reasoning: z.string(),
});

/** `{"reasoning": "...", "verdict": "..."}`, the reasoning taken whole. */
const REASONING_FIRST =
  /^\{\s*"reasoning"\s*:\s*"([\s\S]*)"\s*,\s*"verdict"\s*:\s*"(yes|no|unknown)"\s*\}$/i;
/** `{"verdict": "...", "reasoning": "..."}`, the reasoning taken whole. */
const VERDICT_FIRST =
  /^\{\s*"verdict"\s*:\s*"(yes|no|unknown)"\s*,\s*"reasoning"\s*:\s*"([\s\S]*)"\s*\}$/i;

/**
 * A model sometimes quotes words in its reasoning without escaping the
 * quotes, so its answer isn't JSON, though its verdict is plain. This reads
 * an answer that is exactly the two fields, in either order, with one
 * `"verdict":` key in all its text and nothing shaped like a key (`"name":`)
 * in its reasoning. Anything else isn't read: a second `"verdict":` may be
 * the reasoning quoting one, or a second object; a key in the reasoning may
 * be another field, or quoted JSON with a verdict of its own; and the
 * verdict must be the model's own.
 */
function malformedAnswer(
  text: string
): { verdict: QuestionVerdict; reasoning: string } | null {
  if ((text.match(/"verdict"\s*:/g) ?? []).length !== 1) return null;
  const first = REASONING_FIRST.exec(text);
  const last = first ? null : VERDICT_FIRST.exec(text);
  const answer = first
    ? { reasoning: first[1]!, verdict: first[2]! }
    : last
      ? { verdict: last[1]!, reasoning: last[2]! }
      : null;
  if (!answer || /"[^"\s]+"\s*:/.test(answer.reasoning)) return null;
  return {
    verdict: answer.verdict.toLowerCase() as QuestionVerdict,
    reasoning: answer.reasoning,
  };
}

/**
 * Reads a model's answer: the JSON object itself, or the last one in the
 * text that has the answer's shape (models sometimes reason first), or one
 * whose reasoning has unescaped quotes (`malformedAnswer`).
 */
export function parseQuestionAnswer(
  text: string,
  truncated = false
): { verdict: QuestionVerdict; reasoning: string } {
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
    const verdict =
      candidate && typeof candidate === 'object'
        ? (candidate as { verdict?: unknown }).verdict
        : undefined;
    const normalized =
      typeof verdict === 'string'
        ? { ...(candidate as object), verdict: verdict.toLowerCase() }
        : candidate;
    const parsed = AnswerSchema.safeParse(normalized);
    if (parsed.success) return parsed.data;
  }
  // Valid JSON was the model's answer, right or wrong, and a cut-off answer
  // has no verdict of its own yet.
  const malformed = json || truncated ? null : malformedAnswer(cleaned);
  if (malformed) return malformed;
  throw new Error(
    truncated
      ? `The judge's answer was cut off at its token limit before its JSON was complete; raise the judge's maxTokens. Answer: ${text}`
      : `The judge's answer isn't {"reasoning", "verdict": "yes" | "no" | "unknown"}: ${text.slice(0, 500)}`
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
const UNREADABLE_ANSWER_RETRIES = 1;

async function askJudgeQuestion(
  complete: JudgeCompletionAdapter,
  trace: string,
  question: string
): Promise<QuestionAnswer> {
  const started = Date.now();
  const usage: Partial<UsageMetrics>[] = [];
  for (let attempt = 0; ; attempt++) {
    const completion = await complete({
      system: QUESTION_SYSTEM_PROMPT,
      prompt: questionPrompt(trace, question),
    });
    usage.push(
      Object.fromEntries(
        Object.entries(completion.usage ?? {}).filter(
          ([, v]) => v !== undefined
        )
      ) as Partial<UsageMetrics>
    );
    const truncated = completion.truncated === true;
    let answer: { verdict: QuestionVerdict; reasoning: string };
    try {
      answer = parseQuestionAnswer(completion.text, truncated);
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
function sampleTraces(reference: boolean | undefined): string[] {
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
    defaults: {
      provider: DEFAULT_JUDGE_PROVIDER,
      models: DEFAULT_JUDGE_MODELS,
      maxTokens: DEFAULT_JUDGE_MAX_TOKENS,
      temperature: DEFAULT_JUDGE_TEMPERATURE,
      maxToolOutputSize: DEFAULT_TRACE_OUTPUT_BYTES,
    },
  });
  function llmConfig(options: JudgeLLMOptions): JudgeConfig {
    const { maxToolOutputSize: _size, ...config } = JudgeLLMSchema.parse(
      Object.fromEntries(
        Object.keys(JudgeLLMSchema.shape)
          .filter((key) => key in options)
          .map((key) => [key, options[key as keyof JudgeLLMOptions]])
      )
    );
    return config;
  }
  return {
    description: spec.description,
    schema,
    version,
    ...(spec.requires !== undefined ? { requires: spec.requires } : {}),
    async evaluate(input, rawOptions) {
      const options = schema.parse(rawOptions) as z.infer<
        z.ZodObject<Options>
      > &
        JudgeLLMOptions;
      const config = llmConfig(options);
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
      return {
        ...combineAnswers(answers),
        provider,
        model: config.model ?? DEFAULT_JUDGE_MODELS[provider],
      };
    },
    async preflight(rawOptions) {
      await preflightJudge(
        llmConfig(schema.parse(rawOptions) as JudgeLLMOptions)
      );
    },
  };
}
