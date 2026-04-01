import { z } from 'zod';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import type { SnapshotSanitizer } from '../assertions/validators/types.js';
import type { BuiltInRubric } from '../judge/judgeTypes.js';

// Re-export sanitizer types from canonical source (validators/types.ts)
// Note: For JSON datasets, the Zod schema below validates that patterns are strings.
// The TypeScript types allow RegExp for runtime usage with Playwright matchers.
export type {
  BuiltInSanitizer,
  SnapshotSanitizer,
  RegexSanitizer,
  FieldRemovalSanitizer,
} from '../assertions/validators/types.js';

/**
 * Evaluation mode
 */
export type EvalMode = 'direct' | 'mcp_host';

/**
 * A single eval test case
 *
 * For 'direct' mode: toolName and args are required
 * For 'mcp_host' mode: scenario and mcpHostConfig are required
 */
export interface EvalCase {
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
   * - 'mcp_host': LLM-driven tool selection via natural language
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
   * Natural language scenario for LLM to execute (optional, required for 'mcp_host' mode)
   *
   * @example "Get the weather for London and tell me if I need an umbrella"
   */
  scenario?: string;

  /**
   * MCP host configuration (optional for 'mcp_host' mode)
   *
   * If not specified, uses default configuration from test environment
   */
  mcpHostConfig?: MCPHostConfig;

  /**
   * Additional metadata for this test case
   *
   * For 'mcp_host' mode, can include 'expectedToolCalls' for validation
   */
  metadata?: Record<string, unknown>;

  /**
   * Number of times to run this case and compute an assertion pass rate.
   * When > 1, `EvalCaseResult.assertionPassRate` is populated and `pass` is determined
   * by `accuracyThreshold` rather than a single run.
   * @default 1
   */
  iterations?: number;

  /**
   * Minimum accuracy (0–1) required to pass when `iterations > 1`.
   * @default 1.0 (all iterations must pass)
   */
  accuracyThreshold?: number;

  /**
   * Number of times to invoke the LLM judge per `passesJudge` assertion.
   * Scores are averaged; the mean must meet the threshold to pass.
   * Reduces judge variance caused by non-determinism.
   * Per-assertion `passesJudge.reps` overrides this value.
   * @default 1
   */
  judgeReps?: number;

  /**
   * Golden/expected answer for this case.
   * When set, automatically passed as `reference` to the LLM judge
   * (unless passesJudge.reference is explicitly provided).
   * Mirrors EvalV2's `canonical_answer` field.
   */
  canonicalAnswer?: string;

  /**
   * Arbitrary string labels for this case.
   * Use for filtering eval runs with `EvalRunnerOptions.filterTags`
   * and for slicing results by category.
   *
   * @example ['tool-finding', 'multi-hop', 'search']
   */
  tags?: string[];

  /**
   * Expectations to validate against the tool response
   *
   * Multiple expectations can be combined and will all be validated.
   *
   * @example
   * ```json
   * {
   *   "id": "weather-london",
   *   "toolName": "get_weather",
   *   "args": { "city": "London" },
   *   "expect": {
   *     "containsText": ["temperature", "conditions"],
   *     "schema": "WeatherResponse",
   *     "responseSize": { "maxBytes": 10000 },
   *     "isError": false
   *   }
   * }
   * ```
   */
  expect?: EvalExpectBlock;
}

/**
 * Unified expectation block for eval cases
 *
 * Mirrors the Playwright matcher API for consistency.
 */
export interface EvalExpectBlock {
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
   */
  passesJudge?: {
    /**
     * Name of a registered custom judge executor.
     * When set, the named judge handles evaluation and returns a normalized score.
     * The `threshold` determines pass/fail. `reps` and LLM config fields
     * (provider, model, etc.) are ignored.
     */
    judge?: string;
    /** Built-in rubric name or custom rubric object. Required when no `judge` is specified. */
    rubric?: BuiltInRubric | { text: string };
    /** Reference response to compare against */
    reference?: unknown;
    /** Score threshold for passing (0-1, default: 0.7) */
    threshold?: number;
    /** Number of judge evaluations for this assertion. Overrides EvalCase.judgeReps. */
    reps?: number;
    /** Judge provider. @default 'anthropic' */
    provider?:
      | 'anthropic'
      | 'vertex-anthropic'
      | 'anthropic-agent-sdk'
      | 'openai'
      | 'google';
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
  };

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
   * Asserts which tools the LLM called during a mcp_host simulation.
   * Only meaningful for mcp_host mode — direct mode has no tool call trace.
   */
  toolsTriggered?: {
    /** Expected tool calls */
    calls: Array<{
      /** Tool name */
      name: string;
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
   * Asserts the number of tool calls made during a mcp_host simulation.
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
  provider: z.enum([
    'openai',
    'anthropic',
    'azure',
    'google',
    'mistral',
    'deepseek',
    'openrouter',
    'xai',
    'vertex-anthropic',
  ]),
  apiKeyEnvVar: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  maxToolCalls: z.number().optional(),
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
 * Zod schema for EvalExpectBlock
 */
const EvalExpectBlockSchema = z.object({
  response: z.unknown().optional(),
  schema: z.string().optional(),
  containsText: z.union([z.string(), z.array(z.string())]).optional(),
  matchesPattern: z.union([z.string(), z.array(z.string())]).optional(),
  snapshot: z.string().optional(),
  snapshotSanitizers: z.array(SnapshotSanitizerSchema).optional(),
  isError: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
  passesJudge: z
    .object({
      judge: z.string().min(1).optional(),
      rubric: z
        .union([
          z.enum([
            'correctness',
            'completeness',
            'groundedness',
            'instruction-following',
            'conciseness',
          ]),
          z.object({ text: z.string().min(1) }),
        ])
        .optional(),
      reference: z.unknown().optional(),
      threshold: z.number().min(0).max(1).optional(),
      reps: z.number().int().min(1).optional(),
      provider: z
        .enum([
          'anthropic',
          'vertex-anthropic',
          'anthropic-agent-sdk',
          'openai',
          'google',
        ])
        .optional(),
      model: z.string().optional(),
      apiKeyEnvVar: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(1).optional(),
      maxBudgetUsd: z.number().positive().optional(),
      maxToolOutputSize: z.number().int().positive().optional(),
    })
    .refine((data) => data.judge !== undefined || data.rubric !== undefined, {
      message: 'Either "judge" or "rubric" must be provided in passesJudge',
    })
    .optional(),
  responseSize: z
    .object({
      maxBytes: z.number().optional(),
      minBytes: z.number().optional(),
    })
    .optional(),
  toolsTriggered: z
    .object({
      calls: z.array(
        z.object({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          required: z.boolean().optional(),
        })
      ),
      order: z.enum(['strict', 'any']).optional(),
      exclusive: z.boolean().optional(),
    })
    .optional(),
  toolCallCount: z
    .object({
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
      exact: z.number().int().min(0).optional(),
    })
    .optional(),
});

/**
 * Zod schema for EvalCase
 *
 * toolName and args are optional for mcp_host mode (which uses scenario instead)
 */
export const EvalCaseSchema = z.object({
  id: z.string().min(1, 'id must not be empty'),
  description: z.string().optional(),
  mode: z.enum(['direct', 'mcp_host']).optional(),
  toolName: z.string().min(1, 'toolName must not be empty').optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  scenario: z.string().optional(),
  mcpHostConfig: MCPHostConfigSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  iterations: z.number().int().min(1).optional(),
  accuracyThreshold: z.number().min(0).max(1).optional(),
  judgeReps: z.number().int().min(1).optional(),
  canonicalAnswer: z.string().optional(),
  tags: z.array(z.string()).optional(),
  expect: EvalExpectBlockSchema.optional(),
});

/**
 * Zod schema for EvalDataset (without schemas field, as schemas aren't serializable)
 */
export const EvalDatasetSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema).min(1, 'dataset must have at least one case'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

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
