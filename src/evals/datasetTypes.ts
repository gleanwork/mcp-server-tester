import { z } from 'zod';
import { kindCheckedReferenceSchema } from './referenceSchemas.js';
import { clientFieldSchemas, type ClientFields } from './clientFields.js';
import type { BuiltInRubric, ProviderKind } from '../judge/judgeTypes.js';
import type { TraceEvent } from './evalFrameworkTypes.js';
import {
  RubricJudgeLLMSchema,
  RubricSpecSchema,
} from '../judge/rubricJudge.js';
import { removedKeys, renamedKeys } from './renamedKeys.js';

/**
 * A single eval case: an input the client under test acts on, and what to
 * assert about what it did. The case runs on the `client`, `model` and
 * `clientOptions` it inherits from the eval (or the run), changed by its own.
 *
 * Direct tool calls aren't cases: write them as Playwright tests with
 * `mcp.callTool()` and the matchers.
 */
export interface EvalCase extends ClientFields {
  /**
   * Unique identifier for this test case
   */
  id: string;

  /**
   * Human-readable description of what this test case validates
   */
  description?: string;

  /**
   * The user's request the client acts on, sent as its prompt.
   *
   * @example "Get the weather for London and tell me if I need an umbrella"
   */
  input: string;

  /** Additional metadata for this test case. */
  metadata?: Record<string, unknown>;

  /**
   * Number of trials (independent runs) of this case. When > 1,
   * `EvalCaseResult.passRate` is the share of trials that passed, and
   * `pass` is decided by `passThreshold`.
   * @default 1
   */
  trials?: number;

  /**
   * Share of trials (0–1) that must pass for the case to pass.
   * @default 1.0 (every trial)
   */
  passThreshold?: number;

  /**
   * Number of times to run each of the case's judges. Scores are averaged;
   * the mean must meet the threshold to pass. Reduces judge variance caused
   * by non-determinism. A judge's own `reps` overrides this value.
   * @default 1
   */
  judgeReps?: number;

  /**
   * What the case expects, for graders: `answer` (the reference answer,
   * passed to judges as `reference` unless a judge sets its own),
   * `criteria` (rubric criteria keyed by name), and any other ground truth.
   * Judges read it as `case.expected`.
   */
  expected?: {
    answer?: unknown;
    criteria?: Record<string, string>;
    [key: string]: unknown;
  };

  /**
   * Arbitrary string labels for this case.
   * Use for filtering eval runs with `EvalRunnerOptions.filterTags`
   * and for slicing results by category.
   *
   * @example ['tool-finding', 'multi-hop', 'search']
   */
  tags?: string[];

  /**
   * Assertions (code graders) each trial must pass. All of them run.
   *
   * @example
   * ```json
   * {
   *   "id": "weather-london",
   *   "toolName": "get_weather",
   *   "args": { "city": "London" },
   *   "assertions": {
   *     "containsText": ["temperature", "conditions"],
   *     "schema": "WeatherResponse",
   *     "responseSize": { "maxBytes": 10000 },
   *     "isError": false
   *   }
   * }
   * ```
   */
  assertions?: EvalAssertions;

  /**
   * Judges (model graders) that score each trial. Each must pass. They run
   * on top of the eval config's `judges`; when the case and the eval config
   * list the same judge, the case's settings win.
   *
   * @example
   * ```json
   * "judges": [
   *   { "type": "rubric", "rubric": "correctness", "threshold": 0.8 },
   *   "acme/judge/completeness"
   * ]
   * ```
   */
  judges?: CaseJudge[];
}

/**
 * One of a case's judges, written like an eval config's: a reference
 * (`acme/judge/completeness`) or `{ "type": <reference>, ...options }`.
 */
export type CaseJudge = string | CaseJudgeConfig;

/** How a judge grades: the settings a case judge and a judge request share. */
interface JudgeSettings {
  /** The judge's options, validated by its schema. */
  options?: Record<string, unknown>;
  /** Other flat fields are the judge's options too. */
  [key: string]: unknown;
  /** The rubric judge's rubric: a built-in name or a custom `{ text }`. */
  rubric?: BuiltInRubric | { text: string };
  /** Reference answer to compare against. Default: the case's `expected.answer`. */
  reference?: unknown;
  /** Score threshold for passing (0-1, default: 0.7) */
  threshold?: number;
  /** Number of judge evaluations. Overrides EvalCase.judgeReps. */
  reps?: number;
  /** The rubric judge's provider. @default 'anthropic' */
  provider?: ProviderKind;
  /** Model override (e.g., 'claude-opus-4-20250514') */
  model?: string;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature for judge LLM (0-1) */
  temperature?: number;
  /** Max budget in USD per evaluation */
  maxBudgetUsd?: number;
  /** Fail if response exceeds this size in bytes before judging */
  maxToolOutputSize?: number;
}

/**
 * A case judge with its settings: `type` names the judge (the built-in
 * `rubric`, or `<namespace>/judge/<name>` from a plugin); `threshold`,
 * `reference` and `reps` say how it grades; other flat fields (or
 * `options`) are the judge's own options.
 */
export interface CaseJudgeConfig extends JudgeSettings {
  type: string;
}

/**
 * The judge request a case judge maps to, as the judge validator takes it.
 */
export interface JudgeExpectConfig extends JudgeSettings {
  /**
   * The judge to run: the built-in `rubric`, or `<namespace>/judge/<name>` from a
   * plugin. It returns a normalized score; `threshold` decides pass/fail and
   * `reps` how many times it scores the response. Other flat fields are the
   * judge's options. Without it, `rubric` is shorthand for the rubric judge.
   */
  judge?: string;
}

/**
 * A case's assertions
 *
 * Mirrors the Playwright matcher API for consistency.
 */
export interface EvalAssertions {
  /**
   * Text substring(s) the client's answer must contain (toContainToolText)
   */
  containsText?: string | string[];

  /**
   * Regex pattern(s) the client's answer must match (toMatchToolPattern)
   */
  matchesPattern?: string | string[];

  /**
   * Asserts which tools the client called. Needs structured tool evidence
   * (a client that reports what it called).
   */
  toolsTriggered?: {
    /** Expected tool calls */
    calls: Array<{
      /** Tool or explicitly selected client event name. */
      name: string;
      kind?: TraceEvent['kind'];
      source?: TraceEvent['source'];
      server?: string;
      /** Expected arguments (partial match — extra keys are allowed) */
      arguments?: Record<string, unknown>;
      /** Whether this call MUST have been made (default: true) */
      required?: boolean;
    }>;
    /**
     * 'strict': calls must appear in the exact order listed
     * 'any': calls can appear in any order (default)
     */
    order?: 'strict' | 'any';
    /** If true, no tool calls outside the `calls` list are allowed */
    exclusive?: boolean;
  };

  /**
   * Asserts the number of tool calls the client made. Needs structured tool
   * evidence.
   */
  toolCallCount?: {
    /** Minimum number of tool calls */
    min?: number;
    /** Maximum number of tool calls */
    max?: number;
    /** Exact number of tool calls */
    exact?: number;
  };
}

/**
 * A complete eval dataset containing multiple test cases
 */
export interface EvalDataset {
  /**
   * Dataset name
   */
  name: string;

  /**
   * Dataset description
   */
  description?: string;

  /**
   * Test cases in this dataset
   */
  cases: Array<EvalCase>;

  /**
   * Additional dataset metadata
   */
  metadata?: Record<string, unknown>;

  /** The snapshot a dataset source with snapshots read: it sets this. */
  snapshot?: string;

  /** A plugin's dataset: which one and which copy. MST sets this when it loads one. */
  origin?: {
    /** The dataset source, `namespace/dataset/name`. */
    type: string;
    /** For a source with snapshots: the copy it read. */
    source?: 'snapshot' | 'live';
    /** The snapshot it read (none for live data). */
    snapshot?: string;
  };
}

/** A case judge's settings, as an eval config writes a judge: `type` names it. */
const CaseJudgeFieldsSchema = z.object({
  type: kindCheckedReferenceSchema('judge'),
  options: z.record(z.string(), z.unknown()).optional(),
  rubric: RubricSpecSchema.optional(),
  reference: z.unknown().optional(),
  threshold: z.number().min(0).max(1).optional(),
  reps: z.number().int().min(1).optional(),
  // The rubric judge's LLM settings, which a case may set flat.
  ...RubricJudgeLLMSchema.shape,
});

const RUBRIC_JUDGE_FIELDS = new Set(Object.keys(CaseJudgeFieldsSchema.shape));

/**
 * One of a case's judges: a reference, or `{ "type": <reference>, ...options }`.
 * A plugin judge's own options may sit next to the grading fields; the
 * rubric judge has no others, so an unknown key there is a typo.
 */
const CaseJudgeSchema = z
  .union([
    kindCheckedReferenceSchema('judge').transform((type) => ({ type })),
    CaseJudgeFieldsSchema.passthrough(),
  ])
  .superRefine((entry, context) => {
    if ('judge' in entry)
      context.addIssue({
        code: 'custom',
        path: ['judge'],
        message: `a case judge names its judge in \`type\`: { "type": "${String(entry.judge)}" }`,
      });
    if (entry.type !== 'rubric') return;
    const unknown = Object.keys(entry).filter(
      (key) => !RUBRIC_JUDGE_FIELDS.has(key) && key !== 'judge'
    );
    if (unknown.length > 0)
      context.addIssue({
        code: 'unrecognized_keys',
        keys: unknown,
        message: `Unrecognized key${unknown.length > 1 ? 's' : ''}: ${unknown.map((key) => `"${key}"`).join(', ')}`,
      });
    const options = (entry as { options?: Record<string, unknown> }).options;
    if (
      (entry as { rubric?: unknown }).rubric === undefined &&
      options?.rubric === undefined
    )
      context.addIssue({
        code: 'custom',
        message:
          'the rubric judge needs a rubric: { "type": "rubric", "rubric": "correctness" }',
      });
  });

/**
 * Zod schema for EvalAssertions
 */
export const EvalAssertionsSchema = z
  .object({
    containsText: z.union([z.string(), z.array(z.string())]).optional(),
    matchesPattern: z.union([z.string(), z.array(z.string())]).optional(),
    toolsTriggered: z
      .object({
        calls: z.array(
          z
            .object({
              name: z.string(),
              kind: z
                .enum([
                  'tool_call',
                  'skill',
                  'command',
                  'subagent',
                  'tool_search',
                ])
                .optional(),
              source: z
                .enum(['mcp', 'builtin'], {
                  error: (issue) =>
                    issue.input === 'host'
                      ? "`source: 'host'` is now `source: 'builtin'` (the client's built-in tools)"
                      : undefined,
                })
                .optional(),
              server: z.string().min(1).optional(),
              arguments: z.record(z.string(), z.unknown()).optional(),
              required: z.boolean().optional(),
            })
            .strict()
        ),
        order: z.enum(['strict', 'any']).optional(),
        exclusive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    toolCallCount: z
      .object({
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(0).optional(),
        exact: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    // Assertions on a direct tool response are Playwright matchers now.
    ...removedKeys({
      response:
        'it checked a tool response: use `toMatchToolResponse` in a Playwright test',
      schema:
        'it checked a tool response: use `toMatchToolSchema` in a Playwright test',
      snapshot:
        'it checked a tool response: use `toMatchToolSnapshot` in a Playwright test',
      snapshotSanitizers:
        'pass sanitizers to `toMatchToolSnapshot` in a Playwright test',
      isError:
        'it checked a tool response: use `toBeToolError` in a Playwright test',
      responseSize:
        'it checked a tool response: use `toHaveToolResponseSize` in a Playwright test',
      passesJudge:
        'list the case\'s judges in `judges`, beside `assertions`: "judges": [{ "type": "rubric", "rubric": "correctness" }]. See docs/migrations/migration-2.0.md#case-judges-sit-beside-assertions',
    }),
  })
  // An unknown key is a mistake: a misspelt assertion would never run.
  .strict();

const DIRECT_CALLS =
  'direct tool calls are Playwright tests: call `mcp.callTool(name, args)` in a test and assert with the matchers (`toContainToolText`, `toMatchToolSchema`, `toBeToolError`, ...). An eval case has an `input` the client acts on';

/**
 * Zod schema for EvalCase
 */
export const EvalCaseSchema = z
  .object({
    id: z.string().min(1, 'id must not be empty'),
    description: z.string().optional(),
    ...clientFieldSchemas,
    input: z.string().min(1, 'input must not be empty'),
    ...removedKeys({
      mode: 'every case runs on the client. Remove `mode`; write a direct tool call as a Playwright test (`mcp.callTool()` with the matchers)',
      toolName: DIRECT_CALLS,
      args: DIRECT_CALLS,
      request:
        'direct requests are Playwright tests: call `mcp.request(method, params, schema)` in a test and assert on its result',
      mcpHostConfig:
        'set the client and model with `client`, `model` and `clientOptions`, on the case, the eval, or runEvalDataset',
      externalHost:
        "run the case in an eval with `client: 'chatgpt'` or a plugin client",
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
    trials: z.number().int().min(1).optional(),
    passThreshold: z.number().min(0).max(1).optional(),
    judgeReps: z.number().int().min(1).optional(),
    expected: z
      .object({
        answer: z.unknown().optional(),
        criteria: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
    tags: z.array(z.string()).optional(),
    assertions: EvalAssertionsSchema.optional(),
    judges: z.array(CaseJudgeSchema).optional(),
    ...renamedKeys({
      scenario: 'input',
      iterations: 'trials',
      accuracyThreshold: 'passThreshold',
      expect: 'assertions',
      canonicalAnswer: 'expected.answer',
    }),
  })
  // A misspelt case setting (`passThresold`) would otherwise be ignored.
  .strict();

/**
 * Zod schema for EvalDataset
 */
export const EvalDatasetSchema = z
  .object({
    /** The editor schema a dataset file may point to. */
    $schema: z.string().optional(),
    name: z.string().min(1, 'name must not be empty'),
    description: z.string().optional(),
    cases: z
      .array(EvalCaseSchema)
      .min(1, 'dataset must have at least one case'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Type for serialized eval dataset (without Zod schemas)
 */
export type SerializedEvalDataset = z.infer<typeof EvalDatasetSchema>;

/**
 * Validates an eval case
 *
 * @param evalCase - The eval case to validate
 * @returns The validated eval case
 * @throws {z.ZodError} If validation fails
 */
export function validateEvalCase(evalCase: unknown): EvalCase {
  return EvalCaseSchema.parse(evalCase);
}

/**
 * Validates a serialized eval dataset
 *
 * @param dataset - The dataset to validate
 * @returns The validated dataset
 * @throws {z.ZodError} If validation fails
 */
export function validateEvalDataset(dataset: unknown): SerializedEvalDataset {
  return EvalDatasetSchema.parse(dataset);
}
