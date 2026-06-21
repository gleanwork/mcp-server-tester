import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalDataset, EvalCase, EvalExpectBlock } from './datasetTypes.js';
import type { TestInfo, Expect } from '@playwright/test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import type { EvalExpectationResult, UsageMetrics } from '../types/index.js';
import type {
  EvalCaseResult,
  EvalCaseRequest,
  IterationResult,
  EvalRunMetadata,
} from '../types/reporter.js';
import {
  saveBaseline,
  loadBaseline,
  buildBaselinePassMap,
} from './baseline.js';
import {
  createStoredEvalArtifact,
  resolveEvalResultStore,
  type EvalResultStoreLike,
  type StoredEvalArtifactMetadata,
} from './resultStore.js';
import {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
  validateToolCalls,
  validateToolCallCount,
  validateJudge,
} from '../assertions/validators/index.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { debugEval } from '../debug.js';
import { sumUsage } from '../utils/usageUtils.js';
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Context passed to the eval runner
 */
export interface EvalContext {
  /**
   * MCP fixture API for interacting with the server
   */
  mcp: MCPFixtureApi;

  /**
   * Optional Playwright TestInfo for reporter integration
   * When provided, eval results will be attached to the test for the MCP reporter
   */
  testInfo?: TestInfo;

  /**
   * Optional Playwright expect function for snapshot testing
   * Required for snapshot expectations to work properly
   */
  expect?: Expect;
}

export type { EvalExpectationResult } from '../types/index.js';

export type {
  EvalCaseRequest,
  EvalCaseResult,
  IterationResult,
  EvalRunMetadata,
} from '../types/reporter.js';

/**
 * Metadata overrides for a single existing MCP tool.
 */
export interface ToolMetadataOverride {
  /**
   * Replacement tool description shown to MCP hosts.
   */
  description?: string;

  /**
   * Replacement input schema shown to MCP hosts.
   */
  inputSchema?: Record<string, unknown>;
}

/**
 * Runtime metadata variant for experimenting with MCP tool discoverability.
 *
 * Tool keys are canonical MCP server tool names. Overrides affect only the
 * metadata returned from listTools(); callTool() still forwards canonical tool
 * names and arguments to the original MCP server.
 */
export interface ToolOverrideVariant {
  /**
   * Stable identifier for this runtime variant.
   */
  id: string;

  /**
   * Optional human-readable explanation of what this variant is testing.
   */
  description?: string;

  /**
   * Per-tool metadata overrides keyed by canonical tool name.
   */
  tools: Record<string, ToolMetadataOverride>;
}

/**
 * Overall result of running an eval dataset
 */
export interface EvalRunnerResult {
  /**
   * Total number of cases
   */
  total: number;

  /**
   * Number of passing cases
   */
  passed: number;

  /**
   * Number of failing cases
   */
  failed: number;

  /**
   * Individual case results
   */
  caseResults: Array<EvalCaseResult>;

  /**
   * Overall execution time in milliseconds
   */
  durationMs: number;

  /**
   * Difference between current pass rate and baseline pass rate.
   * Positive = improvement, negative = regression.
   * Only present when `baselineResultsFrom` was provided.
   */
  deltaPassRate?: number;

  /**
   * Number of cases that regressed: passed in baseline, failed now.
   * Only present when `baselineResultsFrom` was provided.
   */
  regressions?: number;

  /**
   * Number of cases that improved: failed in baseline, passed now.
   * Only present when `baselineResultsFrom` was provided.
   */
  improvements?: number;

  /**
   * Average tool precision across all mcp_host cases that have a
   * `toolsTriggered` expectation (precision = fraction of called tools
   * that were expected). Only present when at least one such case ran.
   */
  datasetToolPrecision?: number;

  /**
   * Average tool recall across all mcp_host cases that have a
   * `toolsTriggered` expectation (recall = fraction of required tools
   * that were actually called). Only present when at least one such case ran.
   */
  datasetToolRecall?: number;

  /**
   * Harmonic mean of `datasetToolPrecision` and `datasetToolRecall`.
   * Only present when at least one case contributes precision/recall data.
   */
  datasetToolF1?: number;

  /**
   * Experiment tracking metadata captured at run time.
   */
  metadata?: EvalRunMetadata;

  /**
   * Aggregate token usage from all mcp_host LLM simulations across all cases.
   */
  totalHostUsage?: UsageMetrics;
}

export type StoredEvalResultRef = 'latest' | { id: string };

export interface StoredEvalResultLoadOptions {
  store: true;
  ref: StoredEvalResultRef;
}

export interface StoredEvalResultSaveOptions {
  store: true;
  ref?: 'latest' | { id?: string };
}

/**
 * Options for running eval dataset
 */
export interface EvalRunnerOptions {
  /**
   * The dataset to run
   */
  dataset: EvalDataset;

  /**
   * Schema registry for schema validation by name
   *
   * Maps schema names to Zod schemas for use with expect.schema
   *
   * @example
   * ```typescript
   * {
   *   schemas: {
   *     WeatherResponse: z.object({ temperature: z.number() }),
   *     ErrorResponse: z.object({ error: z.string() }),
   *   }
   * }
   * ```
   */
  schemas?: Record<string, ZodType>;

  /**
   * Whether to stop on first failure
   * @default false
   */
  stopOnFailure?: boolean;

  /**
   * Optional callback called after each case
   */
  onCaseComplete?: (result: EvalCaseResult) => void | Promise<void>;

  /**
   * Maximum number of eval cases to run concurrently.
   * When > 1, cases run in parallel (ignores stopOnFailure ordering).
   * @default 1 (sequential)
   */
  concurrency?: number;

  /**
   * Default iteration count for `mcp_host` mode cases that do not specify
   * `iterations` explicitly. Has no effect on `direct` mode cases (which are
   * deterministic and always default to 1 iteration).
   *
   * Set to 10 for standard runs or 20 for release gates. Individual cases can
   * still override this with their own `iterations` field.
   *
   * @default 1 (preserves historical behaviour when not set)
   *
   * @example
   * ```typescript
   * // Run all mcp_host cases 10 times each by default
   * await runEvalDataset({ dataset, defaultLlmIterations: 10 }, { mcp });
   * ```
   */
  defaultLlmIterations?: number;

  /**
   * Default number of judge evaluations for cases that do not specify
   * `judgeReps` explicitly. Applies to any case with a `passesJudge`
   * expectation. Per-case `judgeReps` overrides this.
   *
   * @default 1 (single judge run)
   */
  defaultJudgeReps?: number;

  /**
   * When set, only eval cases whose `tags` array contains at least one of
   * the specified tags are run. Cases without a `tags` field are excluded.
   * When undefined or empty, all cases run (default behavior).
   */
  filterTags?: string[];

  /**
   * If set, saves the run results to this file path after completion.
   * Use with `baselineResultsFrom` on the next run for regression detection.
   *
   * @example '.mcp-test-results/baseline.json'
   */
  saveResultsTo?: string | StoredEvalResultSaveOptions;

  /**
   * When true (default), strips the `response` field from each case result
   * before saving the baseline file. Keeps baseline files small and git-friendly —
   * the full tool response is not needed for pass/fail regression detection.
   *
   * Set to false to preserve complete responses in the saved file.
   *
   * @default true
   */
  omitResponsesFromBaseline?: boolean;

  /**
   * When true (default), strips response bodies from each case result before
   * saving to an external result store. Stored artifacts only need the pass/fail
   * shape and tool-call metadata — full response payloads are not necessary
   * for regression detection or history comparison. Set to false when you
   * specifically need stored artifacts to retain complete responses.
   *
   * Defaults to `true` to match the reporter's `redactStoredResponses` default
   * (see `MCPReporter`). Both write paths produce the same redaction shape, so
   * users with both configured don't end up with a mix of redacted and
   * non-redacted artifacts depending on which code path wrote them.
   *
   * @default true
   */
  redactStoredResponses?: boolean;

  /**
   * Optional external result store for loading/saving eval run artifacts.
   */
  resultStore?: EvalResultStoreLike;

  /**
   * If set, loads this file or stored result as the baseline and computes delta metrics vs the current run.
   * Populates `EvalRunnerResult.deltaPassRate`, `.regressions`, `.improvements`,
   * and tags each `EvalCaseResult.baselinePass`.
   */
  baselineResultsFrom?: string | StoredEvalResultLoadOptions;

  /**
   * Runtime MCP tool metadata overrides used for variant experiments.
   *
   * Overrides are applied to the tool list shown to MCP hosts without changing
   * the eval dataset or mutating the underlying MCP server. Tool keys must be
   * canonical tool names exposed by the server.
   */
  toolOverrides?: ToolOverrideVariant;

  /**
   * MCP host model identifier to record in run metadata.
   * Use this to identify which model was used when running mcp_host cases.
   *
   * @example 'claude-opus-4-20250514'
   */
  mcpHostModel?: string;

  /**
   * Judge model identifier to record in run metadata.
   * Use this to identify which model was used for judge evaluations.
   *
   * @example 'claude-sonnet-4-20250514'
   */
  judgeModel?: string;
}

/**
 * Options for running a single eval case
 */
export interface EvalCaseOptions {
  /**
   * Dataset name for the result (defaults to 'single-case')
   */
  datasetName?: string;

  /**
   * Schema registry for schema validation by name
   */
  schemas?: Record<string, ZodType>;

  /**
   * Runtime tool override variant id for reporter/debug metadata.
   */
  toolOverrideVariantId?: string;
}

function createToolOverrideMCP(
  mcp: MCPFixtureApi,
  variant: ToolOverrideVariant
): MCPFixtureApi {
  return {
    ...mcp,

    async listTools(): Promise<Array<Tool>> {
      const tools = await mcp.listTools();
      const knownToolNames = new Set(tools.map((tool) => tool.name));
      const unknownToolNames = Object.keys(variant.tools).filter(
        (name) => !knownToolNames.has(name)
      );

      if (unknownToolNames.length > 0) {
        throw new Error(
          `[mcp-server-tester] toolOverrides variant "${variant.id}" references unknown tool(s): ` +
            unknownToolNames.join(', ')
        );
      }

      return tools.map((tool) => {
        const override = variant.tools[tool.name];
        if (!override) {
          return tool;
        }

        return {
          ...tool,
          ...(override.description !== undefined && {
            description: override.description,
          }),
          ...(override.inputSchema !== undefined && {
            inputSchema: override.inputSchema as Tool['inputSchema'],
          }),
        };
      });
    },

    async callTool<TArgs extends Record<string, unknown>>(
      name: string,
      args: TArgs
    ) {
      return mcp.callTool(name, args);
    },
  };
}

async function executeToolCall(
  evalCase: EvalCase,
  mcp: MCPFixtureApi
): Promise<{ response: unknown; error?: string }> {
  const mode = evalCase.mode || 'direct';

  try {
    if (mode === 'mcp_host') {
      // MCP host simulation mode
      if (!evalCase.scenario) {
        throw new Error(
          `Eval case ${evalCase.id}: scenario is required for mcp_host mode`
        );
      }

      if (!evalCase.mcpHostConfig) {
        throw new Error(
          `Eval case ${evalCase.id}: mcpHostConfig is required for mcp_host mode`
        );
      }

      const simulationResult = await simulateMCPHost(
        mcp,
        evalCase.scenario,
        evalCase.mcpHostConfig
      );

      if (!simulationResult.success) {
        throw new Error(simulationResult.error || 'MCP host simulation failed');
      }

      return { response: simulationResult };
    } else {
      // Direct mode - call tool directly
      if (!evalCase.toolName) {
        throw new Error(
          `Eval case ${evalCase.id}: toolName is required for direct mode`
        );
      }
      if (!evalCase.args) {
        throw new Error(
          `Eval case ${evalCase.id}: args is required for direct mode`
        );
      }

      const result = await mcp.callTool(evalCase.toolName, evalCase.args);
      return { response: result };
    }
  } catch (err) {
    // Note: errors originating from mcp_host simulation are already enriched
    // with actionable context by enrichErrorMessage() in the vercel adapter.
    // Pass the message through unchanged so that hint text reaches the caller.
    return {
      response: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Determines if a case passed based on error and expectation results
 */
function didCasePass(
  error: string | undefined,
  expectations: EvalCaseResult['expectations']
): boolean {
  return (
    !error &&
    Object.values(expectations).every(
      (result) => result === undefined || result.pass
    )
  );
}

/**
 * Configuration for processing expect blocks
 */
interface ExpectBlockConfig {
  schemas?: Record<string, ZodType>;
  playwrightExpect?: Expect;
  judgeReps?: number;
  canonicalAnswer?: string;
}

/**
 * Return type for runExpectBlockValidations, including optional precision/recall metrics
 */
interface ExpectBlockResults {
  expectations: EvalCaseResult['expectations'];
  toolPrecision?: number;
  toolRecall?: number;
}

/**
 * Processes the new unified expect block using validators
 *
 * This function translates the expect block into validation results,
 * calling the appropriate validators for each field.
 */
async function runExpectBlockValidations(
  expectBlock: EvalExpectBlock,
  response: unknown,
  config: ExpectBlockConfig
): Promise<ExpectBlockResults> {
  const results: EvalCaseResult['expectations'] = {};
  let toolPrecision: number | undefined;
  let toolRecall: number | undefined;

  // response (toMatchToolResponse)
  if (expectBlock.response !== undefined) {
    const validation = validateResponse(response, expectBlock.response);
    results.exact = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // schema (toMatchToolSchema)
  if (expectBlock.schema !== undefined) {
    const schema = config.schemas?.[expectBlock.schema];
    if (!schema) {
      results.schema = {
        pass: false,
        details: `Schema "${expectBlock.schema}" not found in schemas registry`,
      };
    } else {
      const validation = validateSchema(response, schema);
      results.schema = {
        pass: validation.pass,
        details: validation.message,
      };
    }
  }

  // containsText (toContainToolText)
  if (expectBlock.containsText !== undefined) {
    const validation = validateText(response, expectBlock.containsText);
    results.textContains = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // matchesPattern (toMatchToolPattern)
  if (expectBlock.matchesPattern !== undefined) {
    const validation = validatePattern(response, expectBlock.matchesPattern);
    results.regex = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // isError (toBeToolError)
  if (expectBlock.isError !== undefined) {
    const validation = validateError(response, expectBlock.isError);
    results.error = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // responseSize (toHaveToolResponseSize)
  if (expectBlock.responseSize !== undefined) {
    const validation = validateSize(response, expectBlock.responseSize);
    results.size = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // toolsTriggered (toHaveToolCalls)
  if (expectBlock.toolsTriggered !== undefined) {
    const validation = validateToolCalls(response, expectBlock.toolsTriggered);
    results.toolsTriggered = {
      pass: validation.pass,
      details: validation.message,
    };
    toolPrecision = validation.metrics?.precision;
    toolRecall = validation.metrics?.recall;
  }

  // toolCallCount (toHaveToolCallCount)
  if (expectBlock.toolCallCount !== undefined) {
    const validation = validateToolCallCount(
      response,
      expectBlock.toolCallCount
    );
    results.toolCallCount = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  // passesJudge (toPassToolJudge) — single or multi-judge
  if (expectBlock.passesJudge !== undefined) {
    const judgeConfigs = Array.isArray(expectBlock.passesJudge)
      ? expectBlock.passesJudge
      : [expectBlock.passesJudge];

    const judgeResultEntries = await Promise.all(
      judgeConfigs.map(async (judgeConfig) => {
        const effectiveReps = judgeConfig.reps ?? config.judgeReps ?? 1;
        const effectiveReference =
          judgeConfig.reference !== undefined
            ? judgeConfig.reference
            : config.canonicalAnswer;
        const validation = await validateJudge(response, {
          ...judgeConfig,
          reference: effectiveReference,
          reps: effectiveReps,
        });

        const judgeName =
          judgeConfig.judge ??
          (typeof judgeConfig.rubric === 'string'
            ? judgeConfig.rubric
            : undefined);

        return {
          pass: validation.pass,
          details: validation.message,
          score: validation.details?.score as number | undefined,
          reasoning: validation.details?.reasoning as string | undefined,
          judgeName,
          judgeProvider: validation.details?.judgeProvider as
            | string
            | undefined,
          judgeModel: validation.details?.judgeModel as string | undefined,
        } satisfies EvalExpectationResult;
      })
    );

    if (judgeResultEntries.length === 1) {
      // Single judge — flat result, same as before
      results.judge = judgeResultEntries[0]!;
    } else {
      // Multi-judge — aggregate with AND semantics
      const allPassed = judgeResultEntries.every((r) => r.pass);
      const passCount = judgeResultEntries.filter((r) => r.pass).length;

      results.judge = {
        pass: allPassed,
        details: `${passCount}/${judgeResultEntries.length} judges passed`,
        judgeResults: judgeResultEntries,
      };
    }
  }

  // snapshot (toMatchToolSnapshot) - requires Playwright expect with custom matcher
  if (expectBlock.snapshot !== undefined) {
    if (!config.playwrightExpect) {
      results.snapshot = {
        pass: false,
        details: 'Snapshot testing requires expect in context',
      };
    } else {
      try {
        // Use custom toMatchToolSnapshot matcher which:
        // 1. Extracts text from the response
        // 2. Applies sanitizers
        // 3. Uses Playwright's native snapshot testing
        const sanitizers = expectBlock.snapshotSanitizers ?? [];
        // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (config.playwrightExpect(response) as any).toMatchToolSnapshot(
          expectBlock.snapshot,
          sanitizers
        );
        results.snapshot = {
          pass: true,
          details: `Matches snapshot "${expectBlock.snapshot}"`,
        };
      } catch (err) {
        results.snapshot = {
          pass: false,
          details: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { expectations: results, toolPrecision, toolRecall };
}

/**
 * Builds the request metadata from an eval case for inclusion in results.
 */
function buildRequest(
  evalCase: EvalCase,
  toolOverrideVariantId?: string
): EvalCaseRequest {
  const request: EvalCaseRequest = {};
  if (evalCase.description) request.description = evalCase.description;
  if (toolOverrideVariantId !== undefined) {
    request.toolOverrideVariantId = toolOverrideVariantId;
  }

  if (evalCase.mode === 'mcp_host') {
    if (evalCase.scenario) request.scenario = evalCase.scenario;
    if (evalCase.mcpHostConfig) {
      request.mcpHostConfig = {
        provider: evalCase.mcpHostConfig.provider,
        ...(evalCase.mcpHostConfig.model !== undefined && {
          model: evalCase.mcpHostConfig.model,
        }),
      };
    }
  } else {
    if (evalCase.args) request.args = evalCase.args;
  }

  return request;
}

function isMCPHostSimulationResult(
  value: unknown
): value is MCPHostSimulationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as MCPHostSimulationResult).toolCalls)
  );
}

/**
 * Runs a single iteration of an eval case (the atomic unit of work).
 * Extracted from runEvalCase to support multi-iteration accuracy loops.
 */
async function runSingleIteration(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions
): Promise<EvalCaseResult> {
  const startTime = Date.now();

  // Execute tool call
  const { response, error } = await executeToolCall(evalCase, context.mcp);

  // Collect expectation results from expect block
  let expectationResults: EvalCaseResult['expectations'] = {};
  let toolPrecision: number | undefined;
  let toolRecall: number | undefined;

  let mcpHostTrace: EvalCaseResult['mcpHostTrace'];

  if (!error && evalCase.expect) {
    const {
      expectations,
      toolPrecision: tp,
      toolRecall: tr,
    } = await runExpectBlockValidations(evalCase.expect, response, {
      schemas: options.schemas,
      playwrightExpect: context.expect,
      judgeReps: evalCase.judgeReps,
      canonicalAnswer: evalCase.canonicalAnswer,
    });
    expectationResults = expectations;
    toolPrecision = tp;
    toolRecall = tr;

    // Build mcpHostTrace when toolsTriggered expectation is present
    if (
      evalCase.expect.toolsTriggered !== undefined &&
      isMCPHostSimulationResult(response)
    ) {
      const expectedNames = new Set(
        evalCase.expect.toolsTriggered.calls.map((c) => c.name)
      );
      const requiredNames = new Set(
        evalCase.expect.toolsTriggered.calls
          .filter((c) => c.required !== false)
          .map((c) => c.name)
      );
      const calledNames = new Set(response.toolCalls.map((c) => c.name));

      mcpHostTrace = {
        calls: response.toolCalls.map((call) => ({
          name: call.name,
          arguments: call.arguments,
          status: expectedNames.has(call.name) ? 'expected' : 'unexpected',
        })),
        missed: Array.from(requiredNames)
          .filter((name) => !calledNames.has(name))
          .map((name) => ({ name })),
      };
    }
  }

  // Extract host usage from simulation result
  const hostUsage =
    isMCPHostSimulationResult(response) && response.usage
      ? response.usage
      : undefined;

  // Build result - use test context for authType and project (Playwright is source of truth)
  return {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    toolName:
      evalCase.scenario != null ? 'mcp_host' : (evalCase.toolName ?? 'unknown'),
    source: 'eval',
    pass: didCasePass(error, expectationResults),
    request: buildRequest(evalCase, options.toolOverrideVariantId),
    response,
    error,
    expectations: expectationResults,
    authType: context.mcp.authType,
    project: context.mcp.project,
    durationMs: Date.now() - startTime,
    tags: evalCase.tags,
    toolPrecision,
    toolRecall,
    mcpHostTrace,
    hostUsage,
  };
}

/**
 * Returns true when the error message appears to be caused by network or
 * infrastructure issues (connection resets, timeouts, rate limits, etc.)
 * rather than an assertion or logic failure.
 *
 * Accepts either an Error object or a plain string error message so it can
 * classify both thrown errors and errors surfaced via result.error.
 */
function isInfrastructureError(err: unknown): boolean {
  let name: string | undefined;
  let msg: string;
  let code: string = '';

  if (err instanceof Error) {
    name = err.name;
    msg = err.message.toLowerCase();
    code = ((err as NodeJS.ErrnoException).code ?? '').toLowerCase();
  } else if (typeof err === 'string') {
    msg = err.toLowerCase();
  } else {
    return false;
  }

  return (
    name?.toLowerCase() === 'aborterror' ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('network') ||
    // Prompt/context overflow — LLM couldn't run, not a tool discoverability failure
    msg.includes('prompt is too long') ||
    msg.includes('context length exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('tokens > ') ||
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('econnrefused')
  );
}

/**
 * Runs a single eval case and returns the result.
 * When `evalCase.iterations > 1`, runs the case N times and returns accuracy.
 *
 * @param evalCase - The eval case to run
 * @param context - Context containing mcp, testInfo, expect
 * @param options - Optional configuration (datasetName, schemas)
 * @returns The result of running the eval case
 *
 * @example
 * ```typescript
 * const result = await runEvalCase(
 *   evalCase,
 *   { mcp, testInfo, expect },
 *   { schemas: { WeatherResponse: WeatherSchema } }
 * );
 *
 * expect(result.pass).toBe(true);
 * ```
 */
export async function runEvalCase(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions = {}
): Promise<EvalCaseResult> {
  const iterations = evalCase.iterations ?? 1;

  if (iterations === 1) {
    return runSingleIteration(evalCase, context, options);
  }

  // Multi-iteration: run N times and compute accuracy
  const iterationResults: IterationResult[] = [];
  let lastResult: EvalCaseResult | null = null;

  for (let i = 0; i < iterations; i++) {
    try {
      const result = await runSingleIteration(evalCase, context, options);
      lastResult = result;
      // Check whether the tool call itself failed due to infrastructure (the
      // error is surfaced as result.error since executeToolCall swallows throws)
      const infraError =
        result.error != null && isInfrastructureError(result.error);
      iterationResults.push({
        pass: result.pass,
        durationMs: result.durationMs,
        error: result.error,
        isInfrastructureError: infraError,
        mcpHostTrace: result.mcpHostTrace,
        hostUsage: result.hostUsage,
      });
    } catch (err) {
      // runSingleIteration should not throw, but guard defensively
      const errorMessage = err instanceof Error ? err.message : String(err);
      iterationResults.push({
        pass: false,
        durationMs: 0,
        error: errorMessage,
        isInfrastructureError: isInfrastructureError(err),
      });
    }
  }

  const infraErrors = iterationResults.filter((r) => r.isInfrastructureError);
  const assertionResults = iterationResults.filter(
    (r) => !r.isInfrastructureError
  );
  const passCount = assertionResults.filter((r) => r.pass).length;
  const assertionPassRate =
    assertionResults.length > 0 ? passCount / assertionResults.length : 0;
  const infrastructureErrorRate = infraErrors.length / iterations;
  const threshold = evalCase.accuracyThreshold ?? 1.0;

  // Fall back to a synthetic result if all iterations threw infrastructure errors
  const baseResult: EvalCaseResult = lastResult ?? {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    toolName:
      evalCase.scenario != null ? 'mcp_host' : (evalCase.toolName ?? 'unknown'),
    source: 'eval',
    pass: false,
    error: iterationResults[0]?.error,
    expectations: {},
    authType: context.mcp.authType,
    project: context.mcp.project,
    durationMs: 0,
    tags: evalCase.tags,
    request: buildRequest(evalCase, options.toolOverrideVariantId),
  };

  const totalHostUsage = iterationResults.reduce(
    (acc, r) => sumUsage(acc, r.hostUsage),
    undefined as UsageMetrics | undefined
  );

  return {
    ...baseResult,
    pass: assertionPassRate >= threshold,
    assertionPassRate,
    assertionPassRateCI: wilsonCI(passCount, assertionResults.length),
    infrastructureErrorRate,
    iterationResults,
    infrastructureErrorCount: infraErrors.length,
    durationMs: iterationResults.reduce((sum, r) => sum + r.durationMs, 0),
    hostUsage: totalHostUsage,
  };
}

/**
 * Computes a 95% Wilson score confidence interval for a proportion.
 *
 * Preferred over naive ±√(p(1-p)/n) because it stays within [0,1] at
 * extreme pass rates and has better coverage at small sample sizes.
 *
 * Returns undefined when n < 2 (not enough data for a meaningful interval).
 */
function wilsonCI(
  k: number,
  n: number
): { lower: number; upper: number } | undefined {
  if (n < 2) return undefined;
  const z = 1.96; // 95% confidence
  const z2 = z * z;
  const ñ = n + z2;
  const p̃ = (k + z2 / 2) / ñ;
  const margin = z * Math.sqrt((p̃ * (1 - p̃)) / ñ);
  return {
    lower: Math.max(0, p̃ - margin),
    upper: Math.min(1, p̃ + margin),
  };
}

/**
 * Runs an array of async tasks with bounded concurrency.
 * Preserves result ordering.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    // `index++` is safe here: JavaScript's event loop is single-threaded, so the
    // read-modify-write of `index` completes atomically before any `await` yields
    // to another worker. Each worker captures a unique `i` before awaiting the task.
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Runs an eval dataset against an MCP server
 *
 * This function composes runEvalCase() for each case in the dataset,
 * adding dataset-level features like stopOnFailure and callbacks.
 *
 * @param options - Eval runner options (dataset, schemas)
 * @param context - Eval context (mcp fixture, optional testInfo, optional expect)
 * @returns Eval results
 *
 * @example
 * // Basic usage
 * const result = await runEvalDataset(
 *   {
 *     dataset,
 *     schemas: { WeatherResponse: WeatherSchema },
 *   },
 *   { mcp }
 * );
 *
 * @example
 * // With MCP reporter integration
 * test('eval dataset', async ({ mcp }, testInfo) => {
 *   const result = await runEvalDataset(
 *     { dataset },
 *     { mcp, testInfo }  // testInfo enables MCP reporter
 *   );
 * });
 */
/**
 * Retrieves the current git commit hash using git rev-parse.
 * Returns undefined if git is unavailable or the directory is not a repo.
 */
async function getGitHash(): Promise<string | undefined> {
  const result = await execFileNoThrow('git', ['rev-parse', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// ponytail: warn once per process, not per call — the message is identical and
// runVariantExperiment / scripted loops call this many times.
let warnedNoTestInfo = false;

export async function runEvalDataset(
  options: EvalRunnerOptions,
  context: EvalContext
): Promise<EvalRunnerResult> {
  const {
    dataset,
    schemas,
    stopOnFailure = false,
    concurrency = 1,
    defaultLlmIterations,
    defaultJudgeReps,
    onCaseComplete,
    filterTags,
    saveResultsTo,
    omitResponsesFromBaseline = true,
    redactStoredResponses,
    resultStore,
    baselineResultsFrom,
    toolOverrides,
    mcpHostModel,
    judgeModel,
  } = options;

  const startTime = Date.now();
  const effectiveContext: EvalContext = toolOverrides
    ? { ...context, mcp: createToolOverrideMCP(context.mcp, toolOverrides) }
    : context;

  // Merge schemas from dataset and options
  const allSchemas = {
    ...dataset.schemas,
    ...schemas,
  };

  // Filter cases by tag if filterTags is set (non-empty array)
  const casesToRun =
    filterTags && filterTags.length > 0
      ? dataset.cases.filter((c) => c.tags?.some((t) => filterTags.includes(t)))
      : dataset.cases;

  // Preflight cost warning: estimate the number of LLM judge API calls this run will make
  const estimatedJudgeCalls = casesToRun.reduce((sum, c) => {
    const effectiveIterations =
      c.mode === 'mcp_host'
        ? (c.iterations ?? defaultLlmIterations ?? 1)
        : (c.iterations ?? 1);
    if (c.expect?.passesJudge == null) return sum;
    const judges = Array.isArray(c.expect.passesJudge)
      ? c.expect.passesJudge
      : [c.expect.passesJudge];
    const totalReps = judges.reduce(
      (r, j) => r + (j.reps ?? c.judgeReps ?? defaultJudgeReps ?? 1),
      0
    );
    return sum + effectiveIterations * totalReps;
  }, 0);

  if (estimatedJudgeCalls > 50) {
    debugEval(
      `Warning: This run will make approximately ${estimatedJudgeCalls} LLM judge API calls. This may incur significant costs.`
    );
  }

  // Build task factories for all cases
  const tasks = casesToRun.map((evalCase) => async () => {
    // Apply defaultLlmIterations to mcp_host cases that don't specify iterations.
    // Direct mode cases are deterministic — they always stay at 1 iteration.
    const withIterations =
      evalCase.mode === 'mcp_host' &&
      evalCase.iterations === undefined &&
      defaultLlmIterations !== undefined
        ? { ...evalCase, iterations: defaultLlmIterations }
        : evalCase;

    // Warn when a mcp_host case opts into multi-iteration accuracy measurement
    // but uses fewer iterations than the guide-recommended minimum.
    // Single-iteration mcp_host runs (the default) are a valid smoke-test pattern
    // and are not warned about — the warning is scoped to cases that have
    // explicitly chosen a multi-iteration count that is too small to be reliable.
    if (evalCase.mode === 'mcp_host') {
      const effectiveIterations = withIterations.iterations ?? 1;
      if (effectiveIterations > 1 && effectiveIterations < 10) {
        console.warn(
          `[mcp-server-tester] Eval case "${evalCase.id}": running ${effectiveIterations} iterations in mcp_host mode ` +
            `may not be statistically reliable. Consider using 10+ iterations for accuracy measurements you can trust.`
        );
      }
    }

    // Apply defaultJudgeReps to any case without explicit judgeReps
    const effectiveCase =
      withIterations.judgeReps === undefined && defaultJudgeReps !== undefined
        ? { ...withIterations, judgeReps: defaultJudgeReps }
        : withIterations;

    const result = await runEvalCase(effectiveCase, effectiveContext, {
      datasetName: dataset.name,
      schemas: allSchemas,
      toolOverrideVariantId: toolOverrides?.id,
    });

    if (onCaseComplete) {
      await onCaseComplete(result);
    }

    return result;
  });

  let caseResults: EvalCaseResult[];

  if (concurrency === 1 || stopOnFailure) {
    // Sequential path — required when stopOnFailure is set
    caseResults = [];
    for (const task of tasks) {
      const result = await task();
      caseResults.push(result);
      if (stopOnFailure && !result.pass) break;
    }
  } else {
    caseResults = await runWithConcurrency(tasks, concurrency);
  }

  const total = caseResults.length;
  const passed = caseResults.filter((r) => r.pass).length;

  const [gitHash] = await Promise.all([getGitHash()]);

  const metadata: EvalRunMetadata = {
    gitHash,
    timestamp: new Date().toISOString(),
    packageVersion: packageJson.version,
    ...(toolOverrides !== undefined && {
      toolOverrideVariantId: toolOverrides.id,
    }),
    ...(mcpHostModel !== undefined && { mcpHostModel }),
    ...(judgeModel !== undefined && { judgeModel }),
  };

  const runHostUsage = caseResults.reduce(
    (acc, r) => sumUsage(acc, r.hostUsage),
    undefined as UsageMetrics | undefined
  );

  const result: EvalRunnerResult = {
    total,
    passed,
    failed: total - passed,
    caseResults,
    durationMs: Date.now() - startTime,
    metadata,
    totalHostUsage: runHostUsage,
  };

  // Load baseline and compute delta if requested
  if (baselineResultsFrom) {
    try {
      const baseline =
        typeof baselineResultsFrom === 'string'
          ? await loadBaseline(baselineResultsFrom)
          : await loadStoredBaseline(baselineResultsFrom, resultStore);
      const baselinePassRate =
        baseline.total > 0 ? baseline.passed / baseline.total : 0;
      const baselineMap = buildBaselinePassMap(baseline);

      const currentCaseIds = result.caseResults.map((cr) => cr.id);
      const unmatchedCount = currentCaseIds.filter(
        (id) => !baselineMap.has(id)
      ).length;
      const unmatchedRatio =
        currentCaseIds.length > 0 ? unmatchedCount / currentCaseIds.length : 0;
      if (unmatchedRatio > 0.2) {
        console.warn(
          `[mcp-server-tester] Baseline comparison: ${unmatchedCount} of ${currentCaseIds.length} cases ` +
            `(${Math.round(unmatchedRatio * 100)}%) have no baseline entry. ` +
            `This may indicate the dataset structure has changed. Results for unmatched cases cannot be compared.`
        );
      }

      for (const cr of result.caseResults) {
        const baselinePass = baselineMap.get(cr.id);
        if (baselinePass !== undefined) {
          cr.baselinePass = baselinePass;
        }
      }

      result.regressions = result.caseResults.filter(
        (cr) => cr.baselinePass === true && !cr.pass
      ).length;
      result.improvements = result.caseResults.filter(
        (cr) => cr.baselinePass === false && cr.pass
      ).length;
      result.deltaPassRate =
        result.total > 0 ? result.passed / result.total - baselinePassRate : 0;
    } catch (err) {
      console.warn(
        `[mcp-server-tester] Could not load baseline from ${formatBaselineRef(baselineResultsFrom)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Aggregate tool precision/recall/F1 across cases that have those metrics
  const mcpHostCases = caseResults.filter(
    (r) => r.toolPrecision !== undefined || r.toolRecall !== undefined
  );
  if (mcpHostCases.length > 0) {
    const avgPrec =
      mcpHostCases.reduce((s, r) => s + (r.toolPrecision ?? 0), 0) /
      mcpHostCases.length;
    const avgRecall =
      mcpHostCases.reduce((s, r) => s + (r.toolRecall ?? 0), 0) /
      mcpHostCases.length;
    result.datasetToolPrecision = avgPrec;
    result.datasetToolRecall = avgRecall;
    result.datasetToolF1 =
      avgPrec + avgRecall > 0
        ? (2 * avgPrec * avgRecall) / (avgPrec + avgRecall)
        : 0;
  }

  // Save results to file if requested
  if (saveResultsTo) {
    if (typeof saveResultsTo === 'string') {
      await saveBaseline(result, saveResultsTo, {
        omitResponses: omitResponsesFromBaseline,
      });
    } else {
      await saveStoredEvalResult(result, saveResultsTo, {
        resultStore,
        omitResponses: redactStoredResponses ?? true,
        metadata: {
          datasetName: dataset.name,
          ...(toolOverrides?.id !== undefined && {
            toolOverrideVariantId: toolOverrides.id,
          }),
          ...(mcpHostModel !== undefined && { mcpHostModel }),
          ...(judgeModel !== undefined && { judgeModel }),
          ...(gitHash !== undefined && { gitHash }),
          packageVersion: packageJson.version,
        },
      });
    }
  }

  // Attach results for MCP reporter if testInfo is provided
  if (context.testInfo) {
    await context.testInfo.attach('mcp-test-results', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ caseResults })),
    });
  } else if (caseResults.length > 0 && !warnedNoTestInfo) {
    warnedNoTestInfo = true;
    console.warn(
      '[mcp-server-tester] runEvalDataset: testInfo not provided — results will not appear in the MCP reporter.\n' +
        'To enable reporting, pass testInfo from the Playwright test function:\n' +
        '  await runEvalDataset({ dataset }, { mcp, testInfo });'
    );
  }

  return result;
}

async function loadStoredBaseline(
  baselineResultsFrom: StoredEvalResultLoadOptions,
  resultStore: EvalResultStoreLike | undefined
): Promise<EvalRunnerResult> {
  if (!resultStore) {
    throw new Error('resultStore is required for store-backed baselines');
  }

  const store = resolveEvalResultStore(resultStore);
  const artifact =
    baselineResultsFrom.ref === 'latest'
      ? await store.loadLatestArtifact<EvalRunnerResult>('eval-runner-result')
      : await store.loadArtifact<EvalRunnerResult>(
          'eval-runner-result',
          baselineResultsFrom.ref.id
        );

  if (!artifact) {
    throw new Error('No latest eval run artifact found');
  }

  return artifact.data;
}

async function saveStoredEvalResult(
  result: EvalRunnerResult,
  saveResultsTo: StoredEvalResultSaveOptions,
  options: {
    resultStore: EvalResultStoreLike | undefined;
    omitResponses: boolean;
    metadata: StoredEvalArtifactMetadata;
  }
): Promise<void> {
  if (!options.resultStore) {
    throw new Error('resultStore is required for store-backed saves');
  }

  const store = resolveEvalResultStore(options.resultStore);
  const data = options.omitResponses ? omitResponsesFromResult(result) : result;
  const id =
    saveResultsTo.ref && saveResultsTo.ref !== 'latest'
      ? saveResultsTo.ref.id
      : undefined;

  await store.saveArtifact(
    createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id,
      data,
      metadata: options.metadata,
    })
  );
}

function omitResponsesFromResult(result: EvalRunnerResult): EvalRunnerResult {
  return {
    ...result,
    caseResults: result.caseResults.map(
      ({ response: _response, ...rest }) => rest
    ),
  };
}

function formatBaselineRef(
  baselineResultsFrom: string | StoredEvalResultLoadOptions
): string {
  if (typeof baselineResultsFrom === 'string') {
    return baselineResultsFrom;
  }
  return baselineResultsFrom.ref === 'latest'
    ? 'resultStore latest'
    : `resultStore ${baselineResultsFrom.ref.id}`;
}
