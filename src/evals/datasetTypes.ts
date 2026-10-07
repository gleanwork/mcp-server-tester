import { z } from 'zod';
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
   * Number of times to invoke the LLM judge per `passesJudge` assertion.
   * Scores are averaged; the mean must meet the threshold to pass.
   * Reduces judge variance caused by non-determinism.
   * Per-assertion `passesJudge.reps` overrides this value.
   * @default 1
   */
  judgeReps?: number;

  /**
   * What the case expects, for graders: `answer` (the reference answer,
   * passed to judges as `reference` unless an assertion sets its own),
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
}

/**
 * Configuration for a single LLM-as-judge evaluation
 */
export interface JudgeExpectConfig {
  /** Plugin options, validated by the judge's schema. */
  options?: Record<string, unknown>;
  /** Flat plugin policy fields are also accepted for eval config integration. */
  [key: string]: unknown;
  /**
   * The judge to run: the built-in `rubric`, or `namespace/name` from a
   * plugin. It returns a normalized score; `threshold` decides pass/fail and
   * `reps` how many times it scores the response. Other flat fields are the
   * judge's options.
   */
  judge?: string;
  /** Built-in rubric name or custom rubric object: shorthand for the `rubric` judge. Required when no `judge` is specified. */
  rubric?: BuiltInRubric | { text: string };
  /** Reference response to compare against */
  reference?: unknown;
  /** Score threshold for passing (0-1, default: 0.7) */
  threshold?: number;
  /** Number of judge evaluations for this assertion. Overrides EvalCase.judgeReps. */
  reps?: number;
  /** Judge provider. @default 'anthropic' */
  provider?: ProviderKind;
  /** Model override (e.g., 'claude-opus-4-20250514') */
  model?: string;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature for judge LLM (0–1) */
  temperature?: number;
  /** Max budget in USD per evaluation */
  maxBudgetUsd?: number;
  /** Fail if response exceeds this size in bytes before judging */
  maxToolOutputSize?: number;
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
   * LLM-as-judge evaluation (toPassToolJudge)
   *
   * Accepts a single judge config or an array for multi-judge evaluation.
   * When an array is provided, all judges must pass (AND semantics).
   */
  passesJudge?: JudgeExpectConfig | JudgeExpectConfig[];

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
}

/**
 * Zod schema for a single judge configuration
 */
const JudgeExpectConfigFieldsSchema = z.object({
  judge: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  rubric: RubricSpecSchema.optional(),
  reference: z.unknown().optional(),
  threshold: z.number().min(0).max(1).optional(),
  reps: z.number().int().min(1).optional(),
  // The rubric judge's LLM settings, which an assertion may set flat.
  ...RubricJudgeLLMSchema.shape,
});

const JUDGE_FIELDS = new Set(Object.keys(JudgeExpectConfigFieldsSchema.shape));

// A named judge's own options may sit next to these fields; a rubric
// assertion has no others, so an unknown key there is a typo.
const JudgeExpectConfigSchema = JudgeExpectConfigFieldsSchema.passthrough()
  .superRefine((config, context) => {
    if (config.judge !== undefined) return;
    const unknown = Object.keys(config).filter((key) => !JUDGE_FIELDS.has(key));
    if (unknown.length > 0)
      context.addIssue({
        code: 'unrecognized_keys',
        keys: unknown,
        message: `Unrecognized key${unknown.length > 1 ? 's' : ''}: ${unknown.map((key) => `"${key}"`).join(', ')}`,
      });
  })
  .transform((config) =>
    config.judge !== undefined
      ? config
      : JudgeExpectConfigFieldsSchema.parse(config)
  )
  .refine((data) => data.judge !== undefined || data.rubric !== undefined, {
    message: 'Either "judge" or "rubric" must be provided in passesJudge',
  });

/**
 * Zod schema for EvalAssertions
 */
export const EvalAssertionsSchema = z
  .object({
    containsText: z.union([z.string(), z.array(z.string())]).optional(),
    matchesPattern: z.union([z.string(), z.array(z.string())]).optional(),
    passesJudge: z
      .union([JudgeExpectConfigSchema, z.array(JudgeExpectConfigSchema).min(1)])
      .optional(),
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
