import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalDataset, EvalCase, EvalExpectBlock } from './datasetTypes.js';
import type { TestInfo, Expect } from '@playwright/test';
import type { ZodType } from 'zod';
import { simulateLLMHost } from './llmHost/llmHostSimulation.js';
import type {
  EvalCaseResult,
  IterationResult,
  EvalRunMetadata,
} from '../types/reporter.js';
import {
  saveBaseline,
  loadBaseline,
  buildBaselinePassMap,
} from './baseline.js';
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
  EvalCaseResult,
  IterationResult,
  EvalRunMetadata,
} from '../types/reporter.js';

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
   * Average tool precision across all llm_host cases that have a
   * `toolsTriggered` expectation (precision = fraction of called tools
   * that were expected). Only present when at least one such case ran.
   */
  datasetToolPrecision?: number;

  /**
   * Average tool recall across all llm_host cases that have a
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
   * Default iteration count for `llm_host` mode cases that do not specify
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
   * // Run all llm_host cases 10 times each by default
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
  saveResultsTo?: string;

  /**
   * If set, loads this file as the baseline and computes delta metrics vs the current run.
   * Populates `EvalRunnerResult.deltaPassRate`, `.regressions`, `.improvements`,
   * and tags each `EvalCaseResult.baselinePass`.
   */
  baselineResultsFrom?: string;

  /**
   * LLM host model identifier to record in run metadata.
   * Use this to identify which model was used when running llm_host cases.
   *
   * @example 'claude-opus-4-20250514'
   */
  llmHostModel?: string;

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
}

async function executeToolCall(
  evalCase: EvalCase,
  mcp: MCPFixtureApi
): Promise<{ response: unknown; error?: string }> {
  const mode = evalCase.mode || 'direct';

  try {
    if (mode === 'llm_host') {
      // LLM host simulation mode
      if (!evalCase.scenario) {
        throw new Error(
          `Eval case ${evalCase.id}: scenario is required for llm_host mode`
        );
      }

      if (!evalCase.llmHostConfig) {
        throw new Error(
          `Eval case ${evalCase.id}: llmHostConfig is required for llm_host mode`
        );
      }

      const simulationResult = await simulateLLMHost(
        mcp,
        evalCase.scenario,
        evalCase.llmHostConfig
      );

      if (!simulationResult.success) {
        throw new Error(simulationResult.error || 'LLM host simulation failed');
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
    // Note: errors originating from llm_host simulation are already enriched
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

  // passesJudge (toPassToolJudge)
  if (expectBlock.passesJudge !== undefined) {
    const effectiveReps = expectBlock.passesJudge.reps ?? config.judgeReps ?? 1;
    const effectiveReference =
      expectBlock.passesJudge.reference !== undefined
        ? expectBlock.passesJudge.reference
        : config.canonicalAnswer;
    const validation = await validateJudge(response, {
      ...expectBlock.passesJudge,
      reference: effectiveReference,
      reps: effectiveReps,
    });
    results.judge = {
      pass: validation.pass,
      details: validation.message,
    };
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
  }

  // Build result - use test context for authType and project (Playwright is source of truth)
  return {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    toolName: evalCase.toolName ?? evalCase.scenario ?? 'unknown',
    source: 'eval',
    pass: didCasePass(error, expectationResults),
    response,
    error,
    expectations: expectationResults,
    authType: context.mcp.authType,
    project: context.mcp.project,
    durationMs: Date.now() - startTime,
    tags: evalCase.tags,
    toolPrecision,
    toolRecall,
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

  if (err instanceof Error) {
    name = err.name;
    msg = err.message.toLowerCase();
  } else if (typeof err === 'string') {
    msg = err.toLowerCase();
  } else {
    return false;
  }

  return (
    name === 'AbortError' ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('network')
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
  const accuracy = assertionPassRate; // backward compat
  const threshold = evalCase.accuracyThreshold ?? 1.0;

  // Fall back to a synthetic result if all iterations threw infrastructure errors
  const baseResult: EvalCaseResult = lastResult ?? {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    toolName: evalCase.toolName ?? evalCase.scenario ?? 'unknown',
    source: 'eval',
    pass: false,
    error: iterationResults[0]?.error,
    expectations: {},
    authType: context.mcp.authType,
    project: context.mcp.project,
    durationMs: 0,
    tags: evalCase.tags,
  };

  return {
    ...baseResult,
    pass: accuracy >= threshold,
    assertionPassRate,
    infrastructureErrorRate,
    accuracy,
    iterationResults,
    infrastructureErrorCount: infraErrors.length,
    durationMs: iterationResults.reduce((sum, r) => sum + r.durationMs, 0),
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
    baselineResultsFrom,
    llmHostModel,
    judgeModel,
  } = options;

  const startTime = Date.now();

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

  // Build task factories for all cases
  const tasks = casesToRun.map((evalCase) => async () => {
    // Apply defaultLlmIterations to llm_host cases that don't specify iterations.
    // Direct mode cases are deterministic — they always stay at 1 iteration.
    const withIterations =
      evalCase.mode === 'llm_host' &&
      evalCase.iterations === undefined &&
      defaultLlmIterations !== undefined
        ? { ...evalCase, iterations: defaultLlmIterations }
        : evalCase;

    // Warn when an llm_host case runs fewer than the guide-recommended iterations.
    // The evals guide recommends >= 10 iterations for statistical reliability.
    if (evalCase.mode === 'llm_host') {
      const effectiveIterations = withIterations.iterations ?? 1;
      if (effectiveIterations < 10) {
        console.warn(
          `[mcp-server-tester] Eval case "${evalCase.id}" uses llm_host mode with only ` +
            `${effectiveIterations} iteration(s). The evals guide recommends >= 10 iterations. ` +
            `See docs/evals-guide.md for guidance on statistical reliability.`
        );
      }
    }

    // Apply defaultJudgeReps to any case without explicit judgeReps
    const effectiveCase =
      withIterations.judgeReps === undefined && defaultJudgeReps !== undefined
        ? { ...withIterations, judgeReps: defaultJudgeReps }
        : withIterations;

    const result = await runEvalCase(effectiveCase, context, {
      datasetName: dataset.name,
      schemas: allSchemas,
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
    ...(llmHostModel !== undefined && { llmHostModel }),
    ...(judgeModel !== undefined && { judgeModel }),
  };

  const result: EvalRunnerResult = {
    total,
    passed,
    failed: total - passed,
    caseResults,
    durationMs: Date.now() - startTime,
    metadata,
  };

  // Load baseline and compute delta if requested
  if (baselineResultsFrom) {
    try {
      const baseline = await loadBaseline(baselineResultsFrom);
      const baselinePassRate =
        baseline.total > 0 ? baseline.passed / baseline.total : 0;
      const baselineMap = buildBaselinePassMap(baseline);

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
        `[mcp-server-tester] Could not load baseline from ${baselineResultsFrom}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Aggregate tool precision/recall/F1 across cases that have those metrics
  const llmHostCases = caseResults.filter(
    (r) => r.toolPrecision !== undefined || r.toolRecall !== undefined
  );
  if (llmHostCases.length > 0) {
    const avgPrec =
      llmHostCases.reduce((s, r) => s + (r.toolPrecision ?? 0), 0) /
      llmHostCases.length;
    const avgRecall =
      llmHostCases.reduce((s, r) => s + (r.toolRecall ?? 0), 0) /
      llmHostCases.length;
    result.datasetToolPrecision = avgPrec;
    result.datasetToolRecall = avgRecall;
    result.datasetToolF1 =
      avgPrec + avgRecall > 0
        ? (2 * avgPrec * avgRecall) / (avgPrec + avgRecall)
        : 0;
  }

  // Save results to file if requested
  if (saveResultsTo) {
    await saveBaseline(result, saveResultsTo);
  }

  // Attach results for MCP reporter if testInfo is provided
  if (context.testInfo) {
    await context.testInfo.attach('mcp-test-results', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ caseResults })),
    });
  } else if (caseResults.length > 0) {
    console.warn(
      '[mcp-server-tester] runEvalDataset: testInfo not provided — results will not appear in the MCP reporter.\n' +
        'To enable reporting, pass testInfo from the Playwright test function:\n' +
        '  await runEvalDataset({ dataset }, { mcp, testInfo });'
    );
  }

  return result;
}
