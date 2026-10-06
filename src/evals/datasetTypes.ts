import { z } from 'zod';
import { TaggedConfigSchema, type ClientConfig } from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import {
  GenerationOptions,
  ClientSkillsModeSchema,
  ProviderSchema,
  SystemPromptOption,
} from './mcpHost/hostOptions.js';
import type { ExternalHostConfig } from './externalHost/types.js';
import { ExternalHostConfigSchema } from './externalHost/schema.js';
import type { SnapshotSanitizer } from '../assertions/validators/types.js';
import type { BuiltInRubric, ProviderKind } from '../judge/judgeTypes.js';
import type { TraceEvent } from './evalFrameworkTypes.js';
import {
  RubricJudgeLLMSchema,
  RubricSpecSchema,
} from '../judge/rubricJudge.js';
import { renamedKeys } from './renamedKeys.js';

// Re-export sanitizer types from canonical source (validators/types.ts)
// Note: For JSON datasets, the Zod schema below validates that patterns are strings.
// The TypeScript types allow RegExp for runtime usage with Playwright matchers.
/**
 * Evaluation mode
 */
export type EvalMode = 'direct' | 'host' | 'mcp_host' | 'external_host';

/**
 * A direct-mode MCP request, used instead of `toolName` + `args`.
 */
export interface EvalDirectRequest {
  /** JSON-RPC method, e.g. 'skills/list', 'skills/get', 'resources/read'. */
  method: string;
  /** Request params (without `_meta`; MST adds the protocol envelope). */
  params?: Record<string, unknown>;
  /** Server label to send it to, when a manifest targets several servers. */
  server?: string;
}

/**
 * A single eval test case
 *
 * For 'direct' mode: toolName and args, or request, are required
 * For 'mcp_host' mode: input and mcpHostConfig are required
 * For 'external_host' mode: input and externalHost are required
 */
export interface EvalCase {
  /** Optional per-case host override: a built-in or a plugin host. */
  host?: ClientConfig;
  /**
   * Unique identifier for this test case
   */
  id: string;

  /**
   * Human-readable description of what this test case validates
   */
  description?: string;

  /**
   * Evaluation mode
   * - 'direct': Direct API calls to MCP tools (default)
   * - 'mcp_host': SDK/CLI host simulation via natural language
   * - 'external_host': Real external MCP host driven by configured capabilities
   *
   * @default 'direct'
   */
  mode?: EvalMode;

  /**
   * Name of the MCP tool to call (required for 'direct' mode, optional for 'mcp_host' mode)
   */
  toolName?: string;

  /**
   * Arguments to pass to the tool (required for 'direct' mode, optional for 'mcp_host' mode)
   */
  args?: Record<string, unknown>;

  /**
   * Direct mode alternative to `toolName`: send any MCP request (for example
   * `skills/get` or `resources/read`) and run the expectations against its
   * JSON result. A JSON-RPC error becomes an error result, so `expect.isError`
   * works as it does for tools. Mutually exclusive with `toolName`.
   *
   * @example { "method": "skills/get", "params": { "uri": "skill://docs/SKILL.md" } }
   */
  request?: EvalDirectRequest;

  /**
   * The user's request the host acts on, sent as its prompt (required for
   * 'mcp_host' and 'external_host' modes).
   *
   * @example "Get the weather for London and tell me if I need an umbrella"
   */
  input?: string;

  /**
   * MCP host configuration (optional for 'mcp_host' mode)
   *
   * If not specified, uses default configuration from test environment
   */
  mcpHostConfig?: MCPHostConfig;

  /**
   * External host configuration (required for 'external_host' mode)
   */
  externalHost?: ExternalHostConfig;

  /**
   * Additional metadata for this test case
   *
   * For 'mcp_host' mode, can include 'expectedToolCalls' for validation
   */
  metadata?: Record<string, unknown>;

  /**
   * Number of trials: attempts at this case. When > 1,
   * `EvalCaseResult.assertionPassRate` is the share of trials that passed, and
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
  /** Flat plugin policy fields are also accepted for manifest integration. */
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
 * Unified expectation block for eval cases
 *
 * Mirrors the Playwright matcher API for consistency.
 */
export interface EvalAssertions {
  /**
   * Exact response match (toMatchToolResponse)
   */
  response?: unknown;

  /**
   * Name of schema to validate against (toMatchToolSchema)
   */
  schema?: string;

  /**
   * Text substring(s) that must be present (toContainToolText)
   */
  containsText?: string | string[];

  /**
   * Regex pattern(s) that must match (toMatchToolPattern)
   */
  matchesPattern?: string | string[];

  /**
   * Snapshot name for comparison (toMatchToolSnapshot)
   */
  snapshot?: string;

  /**
   * Snapshot sanitizers to apply
   */
  snapshotSanitizers?: SnapshotSanitizer[];

  /**
   * Error expectation (toBeToolError)
   * - true: expects any error
   * - false: expects no error
   * - string: expects error containing this message
   */
  isError?: boolean | string | string[];

  /**
   * LLM-as-judge evaluation (toPassToolJudge)
   *
   * Accepts a single judge config or an array for multi-judge evaluation.
   * When an array is provided, all judges must pass (AND semantics).
   */
  passesJudge?: JudgeExpectConfig | JudgeExpectConfig[];

  /**
   * Response size validation (toHaveToolResponseSize)
   */
  responseSize?: {
    /** Maximum allowed size in bytes */
    maxBytes?: number;
    /** Minimum required size in bytes */
    minBytes?: number;
  };

  /**
   * Asserts which tools the LLM called during a host simulation.
   * Only meaningful for mcp_host or external_host runs with high-confidence
   * structured tool evidence — direct mode has no tool call trace.
   */
  toolsTriggered?: {
    /** Expected tool calls */
    calls: Array<{
      /** Tool or explicitly selected host event name. */
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
   * Asserts the number of tool calls made during a host simulation.
   * External-host runs require high-confidence structured tool evidence.
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
   * Optional schema definitions referenced by test cases
   */
  schemas?: Record<string, z.ZodSchema>;

  /**
   * Additional dataset metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Zod schema for MCPHostConfig (simplified for serialization)
 */
const MCPHostConfigSchema = z.object({
  hostType: z.enum(['sdk', 'cli', 'browser', 'desktop']).optional(),
  provider: ProviderSchema.optional(),
  apiKeyEnvVar: z.string().optional(),
  model: z.string().optional(),
  timeout: GenerationOptions.timeout,
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  maxToolCalls: z.number().optional(),
  systemPrompt: SystemPromptOption,
  skills: ClientSkillsModeSchema.optional(),
  cli: z
    .object({
      command: z.string(),
      args: z.array(
        z.string().refine((arg) => !arg.includes('{{scenario}}'), {
          message: '`{{scenario}}` is now `{{prompt}}`',
        })
      ),
      outputFormat: z.enum(['stream-json', 'json']).optional(),
      claudeMcpServers: z.array(z.string().min(1)).optional(),
      timeout: z.number().optional(),
    })
    .optional(),
  mcpServers: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  browser: z
    .object({
      script: z.string(),
      timeout: z.number().optional(),
      headless: z.boolean().optional(),
      storageState: z.string().optional(),
      cookies: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            url: z.string().optional(),
            domain: z.string().optional(),
            path: z.string().optional(),
            expires: z.number().optional(),
            httpOnly: z.boolean().optional(),
            secure: z.boolean().optional(),
            sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
            partitionKey: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

/**
 * Zod schema for SnapshotSanitizer
 */
const SnapshotSanitizerSchema = z.union([
  // Built-in sanitizers
  z.enum(['timestamp', 'uuid', 'iso-date', 'objectId', 'jwt']),
  // Custom regex sanitizer
  z.object({
    pattern: z.string(),
    replacement: z.string().optional(),
  }),
  // Field removal sanitizer
  z.object({
    remove: z.array(z.string()),
  }),
]);

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
    response: z.unknown().optional(),
    schema: z.string().optional(),
    containsText: z.union([z.string(), z.array(z.string())]).optional(),
    matchesPattern: z.union([z.string(), z.array(z.string())]).optional(),
    snapshot: z.string().optional(),
    snapshotSanitizers: z.array(SnapshotSanitizerSchema).optional(),
    isError: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
    passesJudge: z
      .union([JudgeExpectConfigSchema, z.array(JudgeExpectConfigSchema).min(1)])
      .optional(),
    responseSize: z
      .object({
        maxBytes: z.number().optional(),
        minBytes: z.number().optional(),
      })
      .strict()
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
              source: z.enum(['mcp', 'host']).optional(),
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
  })
  // An unknown key is a mistake: a misspelt assertion would never run.
  .strict();

/**
 * Zod schema for EvalDirectRequest
 */
const EvalDirectRequestSchema = z
  .object({
    method: z.string().min(1, 'request.method must not be empty'),
    params: z.record(z.string(), z.unknown()).optional(),
    server: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<EvalDirectRequest>;

/**
 * Zod schema for EvalCase
 *
 * toolName and args are optional for mcp_host mode (which uses scenario instead)
 */
export const EvalCaseSchema = z
  .object({
    id: z.string().min(1, 'id must not be empty'),
    description: z.string().optional(),
    mode: z.enum(['direct', 'host', 'mcp_host', 'external_host']).optional(),
    host: TaggedConfigSchema.optional(),
    toolName: z.string().min(1, 'toolName must not be empty').optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    request: EvalDirectRequestSchema.optional(),
    input: z.string().optional(),
    mcpHostConfig: MCPHostConfigSchema.optional(),
    externalHost: ExternalHostConfigSchema.optional(),
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
  .strict()
  .superRefine((evalCase, context) => {
    if (evalCase.request && evalCase.toolName) {
      context.addIssue({
        code: 'custom',
        path: ['request'],
        message: 'request and toolName are mutually exclusive',
      });
    }
    if (evalCase.request && (evalCase.mode ?? 'direct') !== 'direct') {
      context.addIssue({
        code: 'custom',
        path: ['request'],
        message: 'request is only valid for direct-mode cases',
      });
    }
  });

/**
 * Zod schema for EvalDataset (without schemas field, as schemas aren't serializable)
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
