import { rejectRenamedOptions } from './renamedKeys.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { simulationTrace } from './clientTrace.js';
import {
  isInfrastructureError,
  isInfrastructureFailure,
} from './infrastructureFailure.js';
import type { Trace } from './evalFrameworkTypes.js';
import { installPlugins } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { EvalDataset, EvalCase } from './datasetTypes.js';
import type { ClientOptions } from './clientFields.js';
import {
  checkedExecution,
  executeEvalCase,
  failedExecution,
  type CaseExecution,
  type ClientExecution,
  type ClientResponse,
} from './caseExecution.js';
import type { TraceEvent } from './evalFrameworkTypes.js';
import type { TestInfo } from '@playwright/test';
import {
  buildToolSurface,
  registerPresentedTools,
  type ToolSurface,
} from './toolSurface.js';
import type { Tool } from '@modelcontextprotocol/client';
import { gradeTrial, type GradingOutcome } from './grading.js';
import type {
  MCPProtocolInfo,
  SkillLoad,
  UsageMetrics,
} from '../types/index.js';
import type {
  EvalCaseResult,
  EvalCaseRequest,
  TrialResult,
  EvalRunMetadata,
} from '../types/reporter.js';
import { saveBaseline, loadBaseline } from './baseline.js';
import {
  createStoredEvalArtifact,
  resolveEvalResultStore,
  type EvalResultStoreLike,
  type StoredEvalArtifactMetadata,
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from './resultStore.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { debugEval } from '../debug.js';
import { sumUsage } from '../utils/usageUtils.js';
import { caseJudgeUsage, sumJudgeUsage } from '../judge/judgeContract.js';
import packageJson from '../../package.json' with { type: 'json' };
import { attachReporterData } from '../reporters/channel.js';
import { compareEvalRuns } from './evalRunComparison.js';

/**
 * Context passed to the eval runner
 */
export interface EvalContext {
  /**
   * MCP fixture API for interacting with the server
   */
  mcp?: MCPFixtureApi;

  /**
   * Optional Playwright TestInfo for reporter integration
   * When provided, eval results will be attached to the test for the MCP reporter
   */
  testInfo?: TestInfo;
}

export type { EvalCaseResult } from '../types/reporter.js';

/**
 * Metadata overrides for a single existing MCP tool.
 */
export interface ToolMetadataOverride {
  /**
   * Replacement tool name shown to clients. Calls to it reach the original
   * tool and are recorded under the original name, so a dataset's
   * assertions read the same in every variant; the trace's `rawName` keeps the
   * name the model used.
   */
  name?: string;

  /**
   * Replacement tool description shown to clients.
   */
  description?: string;

  /**
   * Replacement input schema shown to clients.
   */
  inputSchema?: Record<string, unknown>;
}

/**
 * Runtime metadata variant for experimenting with MCP tool discoverability.
 *
 * Tool keys are the tools' names on their servers, or `server.tool` to pick
 * one of several servers. Overrides change what listTools() shows; callTool()
 * maps a renamed tool back to its original name and forwards the arguments
 * unchanged.
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
   * Average tool precision across all client cases that have a
   * `toolsTriggered` assertion (precision = fraction of called tools
   * that were expected). Only present when at least one such case ran.
   */
  datasetToolPrecision?: number;

  /**
   * Average tool recall across all client cases that have a
   * `toolsTriggered` assertion (recall = fraction of required tools
   * that were actually called). Only present when at least one such case ran.
   */
  datasetToolRecall?: number;

  /**
   * Harmonic mean of `datasetToolPrecision` and `datasetToolRecall`.
   * Only present when at least one case contributes precision/recall data.
   */
  datasetToolF1?: number;

  /**
   * Optimization tracking metadata captured at run time.
   */
  metadata?: EvalRunMetadata;

  /**
   * Aggregate token usage from every client case's model calls.
   */
  totalClientUsage?: UsageMetrics;

  /**
   * Aggregate token usage of judges across all cases, from judges that report it.
   */
  totalJudgeUsage?: Partial<UsageMetrics>;
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
   * The client cases run on, the model it uses and its options; a case's own
   * `client`, `model` and `clientOptions` change them. Outside an eval, cases
   * run on `mst`, on the test's MCP connection.
   *
   * @example { client: 'mst', model: 'claude-haiku-4-5' }
   */
  client?: string;
  /** The model the client uses. Recorded in run metadata. */
  model?: string;
  /** The client's own options, such as `systemPrompt` or `skills`. */
  clientOptions?: ClientOptions;

  /** Plugins whose extensions (for example `acme/judge/completeness` judges) the cases use. */
  plugins?: readonly Plugin[];

  /**
   * Protocol to record in run metadata when `context.mcp` is absent (for
   * example eval config evals that connect per case). A function is read when
   * the run finishes.
   */
  protocol?: MCPProtocolInfo | (() => MCPProtocolInfo | undefined);

  /** Canonical tool name to accepted native tool names. */
  toolMap?: Record<string, string[]>;

  /**
   * Optional case executor, replacing the fixture. Returns how the case ran;
   * the runner still owns all scores.
   */
  executeCase?: (evalCase: EvalCase) => Promise<CaseExecution>;

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
   * Default trial count for cases that don't set `trials`.
   *
   * Set to 10 for standard runs or 20 for release gates. Individual cases can
   * still override this with their own `trials` field.
   *
   * @default 1
   *
   * @example
   * ```typescript
   * // Run every client case 10 times by default
   * await runEvalDataset(
   *   { dataset, client: 'mst', model: 'claude-haiku-4-5', defaultTrials: 10 },
   *   { mcp }
   * );
   * ```
   */
  defaultTrials?: number;

  /**
   * Default `passThreshold` for client cases that don't set their own: the
   * share of a case's trials that must pass.
   *
   * @default 1
   */
  defaultPassThreshold?: number;

  /**
   * Default number of judge evaluations for cases that do not specify
   * `judgeReps` explicitly. Applies to any case with `judges`
   * assertion. Per-case `judgeReps` overrides this.
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
   * Every API that stores results uses the same policy and default
   * (`redactStoredResponses` in the result store), so artifacts written by the
   * runner, eval, reporter and comparisons are redacted the same way.
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
   * Runtime MCP tool metadata overrides used for tool optimizations.
   *
   * Overrides are applied to the tool list shown to clients without changing
   * the eval dataset or mutating the underlying MCP server. Tool keys must be
   * canonical tool names exposed by the server.
   */
  toolOverrides?: ToolOverrideVariant;

  /**
   * Judge model identifier to record in run metadata.
   * Use this to identify which model was used for judge evaluations.
   *
   * @example 'claude-sonnet-4-20250514'
   */
  judgeModel?: string;

  /**
   * Who reports the results. `'playwright'` (the default) attaches them to the
   * MCP reporter when `testInfo` is given, and suggests passing it when it
   * isn't. `'none'`: the caller reports them itself (an eval writes
   * results.json), so there's no suggestion.
   */
  reporting?: 'playwright' | 'none';
}

/**
 * Options for running a single eval case
 */
export interface EvalCaseOptions {
  /**
   * The client cases run on, the model it uses and its options; a case's own
   * `client`, `model` and `clientOptions` change them. Outside an eval, cases
   * run on `mst`, on the test's MCP connection.
   *
   * @example { client: 'mst', model: 'claude-haiku-4-5' }
   */
  client?: string;
  /** The model the client uses. Recorded in run metadata. */
  model?: string;
  /** The client's own options, such as `systemPrompt` or `skills`. */
  clientOptions?: ClientOptions;
  /** Plugins whose extensions (for example `acme/judge/completeness` judges) the case uses. */
  plugins?: readonly Plugin[];
  toolMap?: Record<string, string[]>;
  /** Case executor called once per trial; assertions remain runner-owned. */
  executeCase?: (evalCase: EvalCase) => Promise<CaseExecution>;
  /**
   * Dataset name for the result (defaults to 'single-case')
   */
  datasetName?: string;

  /**
   * Runtime tool override variant id for reporter/debug metadata.
   */
  toolVariantId?: string;
}

function createToolOverrideMCP(
  mcp: MCPFixtureApi,
  variant: ToolOverrideVariant
): MCPFixtureApi {
  let surface: ToolSurface | undefined;
  async function load(): Promise<ToolSurface> {
    surface = buildToolSurface([{ tools: await mcp.listTools() }], variant);
    return surface;
  }
  const presented: MCPFixtureApi = {
    ...mcp,

    async listTools(): Promise<Array<Tool>> {
      return (await load()).tools.map((entry) => entry.tool);
    },

    async callTool<TArgs extends Record<string, unknown>>(
      name: string,
      args: TArgs
    ) {
      // Clients list tools before calling them, so a renamed tool resolves;
      // a name the surface doesn't know goes to the server unchanged.
      const entry = surface?.resolve(name);
      return mcp.callTool(entry?.originalName ?? name, args);
    },
  };
  registerPresentedTools(
    presented,
    (name) => surface?.resolve(name)?.originalName
  );
  return presented;
}

function mapToolNames(
  response: ClientResponse,
  toolMap?: Record<string, string[]>
): ClientResponse {
  if (!toolMap) return response;
  const aliases = new Map<string, string>();
  for (const [canonical, names] of Object.entries(toolMap)) {
    for (const name of names) {
      if (aliases.has(name) && aliases.get(name) !== canonical) {
        throw new Error(`Ambiguous tool mapping for ${name}.`);
      }
      aliases.set(name, canonical);
    }
  }
  function mapCall<
    T extends { name: string; server?: string; kind?: TraceEvent['kind'] },
  >(call: T): T {
    if (call.kind !== undefined && call.kind !== 'tool_call') return call;
    const qualified = call.server ? `${call.server}.${call.name}` : call.name;
    return {
      ...call,
      name: aliases.get(qualified) ?? aliases.get(call.name) ?? call.name,
    };
  }
  const events =
    'events' in response && Array.isArray(response.events)
      ? response.events
      : undefined;
  return {
    ...response,
    toolCalls: response.toolCalls.map(mapCall),
    ...(events !== undefined ? { events: events.map(mapCall) } : {}),
  };
}

/** Skill loads to keep per trial (responses are not kept). */
function trialSkillLoads(response: unknown): Pick<TrialResult, 'skillLoads'> {
  const loads = (response as { skillLoads?: unknown } | null | undefined)
    ?.skillLoads;
  return Array.isArray(loads) ? { skillLoads: loads as SkillLoad[] } : {};
}

/** The protocol a run used, from its connection or the runner options. */
function protocolMetadata(
  context: EvalContext,
  option: EvalRunnerOptions['protocol']
): { protocol?: MCPProtocolInfo } {
  const protocol = context.mcp?.protocol?.negotiated
    ? context.mcp.protocol
    : typeof option === 'function'
      ? option()
      : option;
  return protocol?.negotiated ? { protocol } : {};
}

/** Flat protocol fields for stored artifacts (filterable metadata). */
function storedProtocolMetadata(
  protocol: MCPProtocolInfo | undefined
): Pick<StoredEvalArtifactMetadata, 'protocolVersion' | 'protocolEra'> {
  if (!protocol?.negotiated) return {};
  return {
    protocolVersion: protocol.negotiated,
    ...(protocol.era ? { protocolEra: protocol.era } : {}),
  };
}

/**
 * Whether a trial passed: no error, and every grader passed.
 */
function didCasePass(
  error: string | undefined,
  scores: EvalCaseResult['scores']
): boolean {
  return (
    !error &&
    Object.values(scores).every((result) => result === undefined || result.pass)
  );
}

/** Run options renamed in 2.0: passing the old name fails with the new one. */
const RENAMED_RUN_OPTIONS = {
  mcpHostModel: 'model',
  toolOverrideVariantId: 'toolVariantId',
} as const;

/**
 * Builds the request metadata from an eval case for inclusion in results.
 */
function buildRequest(
  evalCase: EvalCase,
  run: EvalCaseOptions
): EvalCaseRequest {
  const toolVariantId = run.toolVariantId;
  const request: EvalCaseRequest = {};
  if (evalCase.description) request.description = evalCase.description;
  if (toolVariantId !== undefined) {
    request.toolVariantId = toolVariantId;
  }
  if (evalCase.trials !== undefined) request.trials = evalCase.trials;
  if (evalCase.passThreshold !== undefined) {
    request.passThreshold = evalCase.passThreshold;
  }
  if (evalCase.judgeReps !== undefined) request.judgeReps = evalCase.judgeReps;
  if (evalCase.tags) request.tags = evalCase.tags;
  if (evalCase.assertions) {
    request.assertions = sanitizeReporterValue(evalCase.assertions) as Record<
      string,
      unknown
    >;
  }
  if (evalCase.judges?.length) {
    request.judges = sanitizeReporterValue(evalCase.judges) as Array<
      string | Record<string, unknown>
    >;
  }

  const client = evalCase.client ?? run.client;
  // A case's own client doesn't take the run's model.
  const model =
    evalCase.model ??
    (evalCase.client === undefined || evalCase.client === run.client
      ? run.model
      : undefined);
  // A case that names no client runs on mst (see playwrightClientOf).
  request.client = client ?? 'mst';
  if (model !== undefined) request.model = model;
  request.input = evalCase.input;
  if (evalCase.expected?.answer !== undefined) {
    const answer = evalCase.expected.answer;
    request.reference =
      typeof answer === 'string' ? answer : JSON.stringify(answer);
  }

  return request;
}

function sanitizeReporterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReporterValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      sanitized[key] = isSecretLikeKey(key)
        ? '[redacted]'
        : sanitizeReporterValue(nestedValue);
    }
    return sanitized;
  }

  if (typeof value === 'function') {
    return '[function]';
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

function isSecretLikeKey(key: string): boolean {
  return /token|secret|password|credential|authorization|api[-_]?key/i.test(
    key
  );
}

/** Normalize declared evidence; anything but structured or observed is none. */
function normalizeEvidence(
  evidence: ClientExecution['evidence']
): ClientExecution['evidence'] {
  if (evidence === undefined) return undefined;
  return evidence === 'structured' || evidence === 'observed'
    ? evidence
    : 'none';
}

/**
 * Runs a single trial of an eval case (the atomic unit of work).
 * Extracted from runEvalCase to support multi-trial pass rate loops.
 */
/**
 * The trace a client case result keeps: the execution's (or one derived from
 * its response), with the case's evidence and error, so they always agree.
 */
function caseTrace(
  client: ClientExecution,
  evidence: ClientExecution['evidence'],
  error: string | undefined
): Trace {
  const {
    evidence: _evidence,
    error: _error,
    ...trace
  } = client.trace ?? simulationTrace(client.response);
  return {
    ...trace,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

async function runTrial(
  evalCase: EvalCase,
  context: EvalContext,
  options: EvalCaseOptions
): Promise<EvalCaseResult> {
  const startTime = Date.now();

  // A custom executor (e.g. an eval's client) replaces the fixture path.
  let execution: CaseExecution;
  try {
    execution = options.executeCase
      ? checkedExecution(await options.executeCase(evalCase))
      : await executeEvalCase(evalCase, context.mcp, {
          client: options.client,
          model: options.model,
          clientOptions: options.clientOptions,
        });
  } catch (error) {
    execution = failedExecution(error);
  }
  const clientExecution =
    execution.kind === 'completed' ? execution : undefined;
  const evidence = normalizeEvidence(
    clientExecution
      ? (clientExecution.evidence ?? clientExecution.response.evidence)
      : undefined
  );
  // Keep evidence consistent in assertions, metrics, reports and redacted artifacts.
  const clientResponse =
    clientExecution && evidence !== undefined
      ? { ...clientExecution.response, evidence }
      : clientExecution?.response;
  const response = clientResponse ?? execution.response;
  const error =
    execution.error ??
    (clientResponse && !clientResponse.success
      ? (clientResponse.error ?? 'Client execution failed.')
      : undefined);
  const clientMetadata =
    clientExecution?.clientMetadata ?? clientResponse?.clientMetadata;

  let outcome: GradingOutcome = { scores: {} };
  if (!error && (evalCase.assertions || evalCase.judges?.length)) {
    outcome = await gradeTrial(evalCase, {
      response: clientResponse
        ? mapToolNames(clientResponse, options.toolMap)
        : response,
      clientResponse: clientResponse,
      evidence,
      clientMetadata,
    });
  }

  const clientUsage = clientExecution?.usage ?? clientResponse?.usage;
  const judgeUsage = caseJudgeUsage(outcome.scores.judge);
  const clientDiagnostics =
    clientExecution?.diagnostics ?? clientResponse?.diagnostics;

  // Build result - use test context for authType and project (Playwright is source of truth)
  return {
    id: evalCase.id,
    datasetName: options.datasetName ?? 'single-case',
    source: 'eval',
    pass: didCasePass(error, outcome.scores),
    request: buildRequest(evalCase, options),
    response,
    error,
    scores: outcome.scores,
    authType: context.mcp?.authType,
    project: context.mcp?.project,
    // Only pre-executed traces need extra time. Live execution is already
    // included in this trial's wall clock.
    durationMs:
      Date.now() - startTime + (execution.preExecutionDurationMs ?? 0),
    tags: evalCase.tags,
    toolPrecision: outcome.toolPrecision,
    toolRecall: outcome.toolRecall,
    toolCallTrace: outcome.toolCallTrace,
    traceEvidence: evidence,
    ...(clientExecution
      ? { trace: caseTrace(clientExecution, evidence, error) }
      : {}),
    ...(clientDiagnostics ? { clientDiagnostics } : {}),
    clientUsage,
    ...(judgeUsage !== undefined && { judgeUsage }),
    clientTelemetry: clientExecution?.telemetry,
    clientMetadata,
  };
}

/**
 * Runs a single eval case and returns the result.
 * When `evalCase.trials > 1`, runs the case N times and returns the pass rate.
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
  rejectRenamedOptions(options, RENAMED_RUN_OPTIONS, 'runEvalCase');
  if (options.plugins) installPlugins(options.plugins);
  const trials = evalCase.trials ?? 1;

  if (trials === 1) {
    return runTrial(evalCase, context, options);
  }

  // Multi-trial: run N times and compute the pass rate
  const trialResults: TrialResult[] = [];
  let lastResult: EvalCaseResult | null = null;

  for (let i = 0; i < trials; i++) {
    try {
      const result = await runTrial(evalCase, context, options);
      lastResult = result;
      // Check whether the tool call itself failed due to infrastructure (the
      // error is surfaced as result.error since executeEvalCase swallows throws)
      const infraError = isInfrastructureFailure(result);
      trialResults.push({
        pass: result.pass,
        scores: result.scores,
        durationMs: result.durationMs,
        error: result.error,
        isInfrastructureError: infraError,
        toolCallTrace: result.toolCallTrace,
        traceEvidence: result.traceEvidence,
        ...(result.trace ? { trace: result.trace } : {}),
        ...(result.clientDiagnostics
          ? { clientDiagnostics: result.clientDiagnostics }
          : {}),
        clientUsage: result.clientUsage,
        ...(result.judgeUsage !== undefined && {
          judgeUsage: result.judgeUsage,
        }),
        clientTelemetry: result.clientTelemetry,
        clientMetadata: result.clientMetadata,
        ...trialSkillLoads(result.response),
      });
    } catch (err) {
      // runTrial should not throw, but guard defensively
      const errorMessage = err instanceof Error ? err.message : String(err);
      trialResults.push({
        pass: false,
        durationMs: 0,
        error: errorMessage,
        isInfrastructureError: isInfrastructureError(err),
      });
    }
  }

  const infraErrors = trialResults.filter((r) => r.isInfrastructureError);
  const assertionResults = trialResults.filter((r) => !r.isInfrastructureError);
  const passCount = assertionResults.filter((r) => r.pass).length;
  const passRate =
    assertionResults.length > 0 ? passCount / assertionResults.length : 0;
  const infrastructureErrorRate = infraErrors.length / trials;
  const threshold = evalCase.passThreshold ?? 1.0;

  // Fall back to a synthetic result if all trials threw infrastructure
  // errors. Each trial's trace is in trialResults; none is the case's.
  const { trace: _lastTrace, ...lastWithoutTrace } = lastResult ?? {};
  const baseResult: EvalCaseResult = lastResult
    ? (lastWithoutTrace as EvalCaseResult)
    : {
        id: evalCase.id,
        datasetName: options.datasetName ?? 'single-case',
        source: 'eval',
        pass: false,
        error: trialResults[0]?.error,
        scores: {},
        authType: context.mcp?.authType,
        project: context.mcp?.project,
        durationMs: 0,
        tags: evalCase.tags,
        request: buildRequest(evalCase, options),
      };

  const totalClientUsage = trialResults.reduce(
    (acc, r) => sumUsage(acc, r.clientUsage),
    undefined as UsageMetrics | undefined
  );

  return {
    ...baseResult,
    pass: passRate >= threshold,
    passRate: passRate,
    passRateCI: wilsonCI(passCount, assertionResults.length),
    infrastructureErrorRate,
    trialResults: trialResults,
    infrastructureErrorCount: infraErrors.length,
    durationMs: trialResults.reduce((sum, r) => sum + r.durationMs, 0),
    clientUsage: totalClientUsage,
    judgeUsage: sumJudgeUsage(trialResults.map((r) => r.judgeUsage)),
    clientTelemetry: undefined,
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
// runToolOptimization / scripted loops call this many times.
let warnedNoTestInfo = false;
const warnedLowTrials = new Set<string>();

export async function runEvalDataset(
  options: EvalRunnerOptions,
  context: EvalContext
): Promise<EvalRunnerResult> {
  rejectRenamedOptions(options, RENAMED_RUN_OPTIONS, 'runEvalDataset');
  const {
    dataset,
    stopOnFailure = false,
    concurrency = 1,
    defaultTrials,
    defaultPassThreshold,
    defaultJudgeReps,
    onCaseComplete,
    filterTags,
    saveResultsTo,
    omitResponsesFromBaseline = REDACT_STORED_RESPONSES_BY_DEFAULT,
    redactStoredResponses: redactStored,
    resultStore,
    baselineResultsFrom,
    toolOverrides,
    judgeModel,
  } = options;
  const model = options.model;
  if (options.plugins) installPlugins(options.plugins);

  const startTime = Date.now();
  const effectiveContext: EvalContext =
    toolOverrides && context.mcp
      ? { ...context, mcp: createToolOverrideMCP(context.mcp, toolOverrides) }
      : context;

  // Filter cases by tag if filterTags is set (non-empty array)
  const casesToRun =
    filterTags && filterTags.length > 0
      ? dataset.cases.filter((c) => c.tags?.some((t) => filterTags.includes(t)))
      : dataset.cases;

  // Preflight cost warning: estimate the number of LLM judge API calls this run will make
  const estimatedJudgeCalls = casesToRun.reduce((sum, c) => {
    const effectiveTrials = c.trials ?? defaultTrials ?? 1;
    if (!c.judges?.length) return sum;
    const totalReps = c.judges.reduce(
      (r, j) =>
        r +
        ((typeof j === 'string' ? undefined : j.reps) ??
          c.judgeReps ??
          defaultJudgeReps ??
          1),
      0
    );
    return sum + effectiveTrials * totalReps;
  }, 0);

  if (estimatedJudgeCalls > 50) {
    debugEval(
      `Warning: This run will make approximately ${estimatedJudgeCalls} LLM judge API calls. This may incur significant costs.`
    );
  }

  // Build task factories for all cases
  const tasks = casesToRun.map((evalCase) => async () => {
    // Apply defaultTrials and defaultPassThreshold to cases that don't set them.
    const withTrialDefaults = {
      ...evalCase,
      ...(evalCase.trials === undefined && defaultTrials !== undefined
        ? { trials: defaultTrials }
        : {}),
      ...(evalCase.passThreshold === undefined &&
      defaultPassThreshold !== undefined
        ? { passThreshold: defaultPassThreshold }
        : {}),
    };

    // Warn when a client case runs several trials, but fewer than the
    // guide's minimum. One trial (the default) is a valid smoke test, so the
    // warning is only for a count chosen too small to be reliable.
    {
      const effectiveTrials = withTrialDefaults.trials ?? 1;
      // Once per case and count: a runs the same case in every variant.
      const warning = `${evalCase.id}\u0000${effectiveTrials}`;
      if (
        effectiveTrials > 1 &&
        effectiveTrials < 10 &&
        !warnedLowTrials.has(warning)
      ) {
        warnedLowTrials.add(warning);
        console.warn(
          `[mcp-server-tester] Eval case "${evalCase.id}": running ${effectiveTrials} trials ` +
            `may not be statistically reliable. Consider 10+ trials for pass rates you can trust.`
        );
      }
    }

    // Apply defaultJudgeReps to any case without explicit judgeReps
    const effectiveCase =
      withTrialDefaults.judgeReps === undefined &&
      defaultJudgeReps !== undefined
        ? { ...withTrialDefaults, judgeReps: defaultJudgeReps }
        : withTrialDefaults;

    const result = await runEvalCase(effectiveCase, effectiveContext, {
      client: options.client,
      model: options.model,
      clientOptions: options.clientOptions,
      executeCase: options.executeCase,
      toolMap: options.toolMap,
      datasetName: dataset.name,
      toolVariantId: toolOverrides?.id,
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
      toolVariantId: toolOverrides.id,
    }),
    ...(model !== undefined && { model }),
    ...(judgeModel !== undefined && { judgeModel }),
    ...protocolMetadata(context, options.protocol),
  };

  const runClientUsage = caseResults.reduce(
    (acc, r) => sumUsage(acc, r.clientUsage),
    undefined as UsageMetrics | undefined
  );

  const runJudgeUsage = sumJudgeUsage(caseResults.map((r) => r.judgeUsage));

  const result: EvalRunnerResult = {
    total,
    passed,
    failed: total - passed,
    caseResults,
    durationMs: Date.now() - startTime,
    metadata,
    totalClientUsage: runClientUsage,
    ...(runJudgeUsage !== undefined && { totalJudgeUsage: runJudgeUsage }),
  };

  // Load baseline and compute delta if requested
  if (baselineResultsFrom) {
    try {
      const baseline =
        typeof baselineResultsFrom === 'string'
          ? await loadBaseline(baselineResultsFrom)
          : await loadStoredBaseline(baselineResultsFrom, resultStore);
      const comparison = compareEvalRuns({ baseline, candidate: result });
      const currentCount = result.caseResults.length;
      const unmatchedCount = comparison.missingFromBaseline.length;
      const unmatchedRatio =
        currentCount > 0 ? unmatchedCount / currentCount : 0;
      if (unmatchedRatio > 0.2) {
        console.warn(
          `[mcp-server-tester] Baseline comparison: ${unmatchedCount} of ${currentCount} cases ` +
            `(${Math.round(unmatchedRatio * 100)}%) have no baseline entry. ` +
            `This may indicate the dataset structure has changed. Results for unmatched cases cannot be compared.`
        );
      }

      // Annotate the current results, which the comparison holds by reference.
      const baselinePassById = new Map(
        comparison.cases.flatMap((entry) =>
          entry.baseline && entry.candidate
            ? [[entry.id, entry.baseline.pass] as const]
            : []
        )
      );
      for (const cr of result.caseResults) {
        const baselinePass = baselinePassById.get(cr.id);
        if (baselinePass !== undefined) cr.baselinePass = baselinePass;
      }

      // Count from the annotation, so the counts always agree with each
      // case's baselinePass (also when a dataset repeats a case ID).
      result.regressions = result.caseResults.filter(
        (cr) => cr.baselinePass === true && !cr.pass
      ).length;
      result.improvements = result.caseResults.filter(
        (cr) => cr.baselinePass === false && cr.pass
      ).length;
      // An empty run has nothing to compare, so no delta.
      result.deltaPassRate = result.total > 0 ? comparison.deltaPassRate : 0;
    } catch (err) {
      console.warn(
        `[mcp-server-tester] Could not load baseline from ${formatBaselineRef(baselineResultsFrom)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Aggregate tool precision/recall/F1 across cases that have those metrics
  const toolCallCases = caseResults.filter(
    (r) => r.toolPrecision !== undefined || r.toolRecall !== undefined
  );
  if (toolCallCases.length > 0) {
    const avgPrec =
      toolCallCases.reduce((s, r) => s + (r.toolPrecision ?? 0), 0) /
      toolCallCases.length;
    const avgRecall =
      toolCallCases.reduce((s, r) => s + (r.toolRecall ?? 0), 0) /
      toolCallCases.length;
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
        omitResponses: redactStored ?? REDACT_STORED_RESPONSES_BY_DEFAULT,
        metadata: {
          datasetName: dataset.name,
          ...(toolOverrides?.id !== undefined && {
            toolVariantId: toolOverrides.id,
          }),
          ...(model !== undefined && { model }),
          ...(judgeModel !== undefined && { judgeModel }),
          ...(gitHash !== undefined && { gitHash }),
          ...storedProtocolMetadata(metadata.protocol),
          packageVersion: packageJson.version,
        },
      });
    }
  }

  // Attach results for MCP reporter if testInfo is provided
  if (context.testInfo) {
    await attachReporterData(context.testInfo, {
      kind: 'evalResults',
      data: { caseResults },
    });
  } else if (
    caseResults.length > 0 &&
    options.reporting !== 'none' &&
    !warnedNoTestInfo
  ) {
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
  const data = options.omitResponses ? redactStoredResponses(result) : result;
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

/**
 * A copy of the result without raw responses, under the same policy as every
 * stored artifact (`redactStoredResponses`).
 */
export function omitResponsesFromResult(
  result: EvalRunnerResult
): EvalRunnerResult {
  return redactStoredResponses(result);
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
