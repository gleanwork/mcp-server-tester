import type { MCPToolOptimizationData } from '../types/reporter.js';
import type { Plugin } from '../plugins/plugin.js';
import type { RUN_FORMAT } from './resultFormat.js';
import type { ZodType } from 'zod';
import type { EvalDataset, EvalCase } from './datasetTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { ClientDiagnostics, UsageMetrics } from '../types/index.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type {
  DatasetConfig,
  EvalVariant,
  EvalConfig,
  ExtensionConfig,
  ClientConfig,
  ModelPricing,
} from './evalConfig.js';
import type { EvalResultStore } from './resultStore.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { JudgeInput, JudgeScore } from '../judge/judgeContract.js';
import type { PairwiseComparisonResult } from './pairwiseComparison.js';

/** Context provided to a dataset source implementation. */
export interface DatasetSourceContext {
  rootDir: string;
  /** The eval config's directory; relative paths resolve here before `rootDir`. */
  configDir?: string;
  evalConfig: EvalConfig;
}

/** Public dataset-source extension point. */
export interface DatasetSource {
  readonly schema: ZodType;
  load(
    config: DatasetConfig,
    context: DatasetSourceContext
  ): Promise<EvalDataset>;
}

/** Options supplied to a client implementation. */
export interface ClientRunOptions {
  dataset: EvalDataset;
  cases: EvalCase[];
  servers: MCPConfig[];
  client: ClientConfig;
  evalConfig: EvalConfig;
  variant?: EvalVariant;
  dryRun?: boolean;
}

export interface ClientRunInput {
  /** The case's input, sent to the client as its prompt. */
  prompt: string;
  servers: MCPConfig[];
  /**
   * When `servers` go through MST's tool-variant proxy: the same servers on
   * an endpoint for MST's own checks (such as a readiness probe), so the
   * check's traffic isn't taken for the client's. Connect the client itself
   * only to `servers`.
   */
  checkServers?: MCPConfig[];
  /** Execution-local environment; never persisted. */
  env?: Record<string, string | undefined>;
}

export interface ClientRunContext {
  evalConfig: EvalConfig;
  variant?: EvalVariant;
  /** Runtime-only environment isolated per eval. */
  env?: Record<string, string | undefined>;
  /**
   * For `runBatch`: report a request's result as soon as it finishes, with
   * its index in `requests`, so the eval saves the trial before the batch
   * ends. Optional, and it never throws. Report a result once, and don't
   * change it after; `runBatch` still returns every result.
   */
  reportResult?: (index: number, result: ClientRunResult) => Promise<void>;
}

export type TraceEvidence = 'structured' | 'observed' | 'none';
export interface TraceEvent {
  /**
   * `tool_call` for MCP and host tools; host-native `skill` loads, `command`
   * runs, `subagent` starts, and `tool_search` catalog searches.
   */
  kind: 'tool_call' | 'skill' | 'command' | 'subagent' | 'tool_search';
  source: 'mcp' | 'builtin';
  name: string;
  server?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  /** Explicit tool-result error status, absent when not observed. */
  isError?: boolean;
  rawName?: string;
  id?: string;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  /** `tool_search` only: the tools the search returned, by name and server. */
  results?: Array<{ name: string; server?: string }>;
}

/** One execution trace. Clients never return evaluation scores. */
export interface ClientRunResult {
  diagnostics?: ClientDiagnostics;
  finalText: string;
  events: TraceEvent[];
  error?: string;
  usage?: UsageMetrics;
  /** Native and driver observations remain separately scoped; UI actions are not LLM usage. */
  telemetry?: Record<string, unknown>;
  /** Per-request wall time, excluding shared batch setup and cleanup. */
  durationMs?: number;
  llmDurationMs?: number;
}

/**
 * What a client did in one trial: the `ClientRunResult` it returned, without
 * telemetry and diagnostics, plus the evidence it declared. Case results keep
 * it for client cases (one per trial). In an eval, every MCP event names its
 * `server` label. Stored results drop `finalText` and event `output`, which
 * can hold data from the server under test.
 */
export type Trace = Pick<ClientRunResult, 'events' | 'usage' | 'error'> & {
  finalText?: string;
  /** Declared evidence; absent for the legacy simulated client. */
  evidence?: TraceEvidence;
};

export interface ClientBatchRequest {
  caseId: string;
  /** Which trial of the case this is, from 0. */
  trial: number;
  input: ClientRunInput;
  config: ClientConfig;
}

/** Public client extension point. */
export interface ClientDefinition {
  readonly schema: ZodType;
  /** Missing evidence declarations are treated as unverified. */
  readonly evidence?: TraceEvidence;
  /**
   * The client shows the model a variant's tool metadata (`tools`, read from
   * `context.variant` or `context.evalConfig`) itself. Without it, an eval
   * config that sets `tools` for this client fails validation, unless the
   * client gets them through MST's proxy (see `toolSurfaceProxy`).
   */
  readonly toolMetadata?: boolean;
  /**
   * For clients with `run` or `runBatch` that don't set `toolMetadata`: the
   * client connects to the servers in `input.servers`, so the eval can serve
   * it a variant's tool metadata through a local MCP proxy (the default). Set
   * false for a client that connects elsewhere; an eval config that gives it
   * `tools` then fails validation.
   */
  readonly toolSurfaceProxy?: boolean;
  /**
   * The client connects to one server set for its whole batch, the first
   * request's `input.servers`, rather than to each request's. The proxy then
   * serves the batch on one endpoint, and checks once, for the batch, that
   * the client listed the variant's tools.
   */
  readonly serversPerBatch?: boolean;
  /** The most cases the client can run at once; `concurrency` above it is an error. */
  readonly maxConcurrency?: number;
  /** Ordered traces for all selected trials. The framework owns scores. */
  runBatch?(
    requests: ClientBatchRequest[],
    context: ClientRunContext
  ): Promise<ClientRunResult[]>;
  run?(
    input: ClientRunInput,
    config: ClientConfig,
    context: ClientRunContext
  ): Promise<ClientRunResult>;
}

/** Values emitted by a metric for one evaluation case. */
export type MetricValue =
  | boolean
  | number
  | string
  | Record<string, number>
  | null;

export type MetricKind = 'binary' | 'continuous' | 'categorical' | 'object';

export interface ResolvedMetric {
  readonly metric: MetricDefinition;
  readonly outName: string;
  readonly params: Record<string, unknown>;
}

/** Public metric extension point. */
export interface MetricDefinition {
  readonly schema: ZodType;
  readonly kind: MetricKind;
  readonly unit?: string;
  compute(
    caseResult: EvalCaseResult,
    params?: Record<string, unknown>
  ): MetricValue;
  aggregate?(
    values: MetricValue[],
    metric: ResolvedMetric
  ): { key: string; value: unknown } | undefined;
}

export type { JudgeScore } from '../judge/judgeContract.js';

/**
 * Public judge extension point. Built-in judges (`rubric`) and plugin judges
 * share it: the framework parses `options` with `schema`, builds the judge's
 * input from the case and the run, calls `evaluate` once per rep, and applies
 * the threshold to the mean score unless the judge returns its own `pass`.
 */
export interface JudgeDefinition {
  /** Parses the judge's options. */
  readonly schema: ZodType;
  /**
   * Paths in the judge input this judge needs, such as `case.expected.answer`
   * or `case.expected.criteria`. When one is missing or empty, the judge is
   * not called and the result is recorded as skipped.
   */
  readonly requires?: readonly string[];
  /**
   * Grades one run of a case. `input.case` is the case as written in the
   * dataset; `input.trial` is the observed run. `options` is parsed by `schema`.
   */
  evaluate: (
    input: JudgeInput,
    options: Record<string, unknown>
  ) => Promise<JudgeScore>;
}

/** Public result-store extension point. */
export interface ResultStoreDefinition {
  readonly schema: ZodType;
  create(config: ExtensionConfig): EvalResultStore;
}

/** Options shared by an eval config runner implementation. */
export interface EvaluationRunOptions {
  configPath: string;
  rootDir?: string;
  /** Plugin specifiers, added to the eval config's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to the eval config's `plugins`. */
  plugins?: readonly Plugin[];
  outputDir?: string;
  secretsFile?: string;
  dryRun?: boolean;
  variant?: string;
}

/** Per-variant result metadata. */
export interface EvaluationVariantResult {
  name: string;
  servers: MCPConfig[];
  result?: EvalRunnerResult;
  /** Outcomes, calls, tokens, cost and time, plus the listed metrics. */
  metrics?: Record<string, unknown>;
  /** The weakest evidence among the variant's cases. */
  evidence?: TraceEvidence;
  /** Listed metrics with no value for this variant (unavailable, not zero). */
  unavailableMetrics?: string[];
  /** Where `cost_usd` comes from: clients, the eval config's `pricing`, or both. */
  costSource?: 'client' | 'pricing' | 'mixed';
  /** The prices the variant's estimates used, by model, so they can be audited later. */
  pricing?: Record<string, ModelPricing>;
  /** Models whose usage had no reported cost and no price: `cost_usd` leaves them out. */
  unpricedModels?: string[];
  comparison?: Record<string, unknown>;
  /**
   * This variant compared with the baseline by the eval config's
   * `pairwiseJudges`: a preference per case and judge, and each judge's
   * win, loss and tie counts. Absent on the baseline, and when the baseline
   * didn't run.
   */
  pairwise?: PairwiseComparisonResult;
}

/** Stable summary shape written by a completed evaluation eval. */
export interface RunTelemetry {
  cases: number;
  toolCalls: number;
  failedCases: number;
  totalClientUsage?: Partial<UsageMetrics>;
  /** Judge model usage, from judges that report it, pairwise judges included. Separate from client usage. */
  totalJudgeUsage?: Partial<UsageMetrics>;
  /** The pairwise judges' share of `totalJudgeUsage`. */
  pairwiseJudgeUsage?: Partial<UsageMetrics>;
}

/** How one variant changed since the previous run of the same eval config. */
export interface PreviousRunVariant {
  passRateDelta: number;
  trialPassRateDelta?: number;
  /** Case IDs that passed before and fail now. */
  regressed: string[];
  /** Case IDs that failed before and pass now. */
  improved: string[];
  /** Case IDs new in this run. */
  added: string[];
  /** Case IDs the previous run had and this one doesn't. */
  removed: string[];
}

/** This run compared with the previous run of the same eval config. */
export interface PreviousRunComparison {
  /** The previous run's `runId`. */
  runId: string;
  timestamp: string;
  /** Whether the eval config was unchanged (`contentHash`; datasets aren't hashed). */
  sameConfig: boolean;
  passRate: number;
  passRateDelta: number;
  /** Variants present in both runs, by name. */
  variants: Record<string, PreviousRunVariant>;
}

/** How a run was narrowed at run time (`mst run --variant/--case/--filter-tag/--max-cases/--trials`). */
export interface RunSelection {
  variants?: string[];
  cases?: string[];
  filterTags?: string[];
  maxCases?: number;
  trials?: number;
  /** The Playwright shard (`1/3`) a reporter's run covers. */
  shard?: string;
}

export interface RunSummary {
  /** This run's ID: its result store artifact ID and output directory name. */
  runId?: string;
  /**
   * Whether the run was narrowed at run time. A partial run is compared only
   * with partial runs narrowed the same way, and never becomes a result
   * store's latest run. Absent in older summaries: a full run.
   */
  partial?: boolean;
  /** What narrowed a partial run. */
  selection?: RunSelection;
  /** A hash of `selection`: partial runs with the same hash are comparable. */
  selectionHash?: string;
  /** This run compared with the previous run of the same eval config, if there is one. */
  previousRun?: PreviousRunComparison;
  /** The run format: see `RUN_FORMAT`. */
  format: typeof RUN_FORMAT;
  configId: string;
  contentHash: string;
  timestamp: string;
  durationMs: number;
  configName: string;
  variants: EvaluationVariantResult[];
  metrics: Record<string, unknown>;
  telemetry?: RunTelemetry;
  variantDeltas: Record<string, Record<string, unknown>>;
  caseArtifactPointers?: Record<string, string[]>;
  results: EvalCaseResult[];
  /** A tool optimization the run reported (the Playwright reporter's runs). */
  toolOptimization?: MCPToolOptimizationData;
}

export type EvaluationSummary = RunSummary;

/** Result contract for an eval implementation. */
export interface EvaluationRunResult {
  evalConfig: EvalConfig;
  outputDir: string;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: EvalDataset;
    result?: EvalRunnerResult;
  }>;
  summary: EvaluationSummary;
}

/** Options for running multiple eval configs. */
export interface EvaluationBatchOptions {
  /** Explicit paths take precedence over configDir when nonempty. */
  configPaths?: string[];
  configDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  skipExisting?: boolean;
  secretsFile?: string;
  /** Plugin specifiers, added to each eval config's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to each eval config's `plugins`. */
  plugins?: readonly Plugin[];
  dryRun?: boolean;
}

export interface EvaluationBatchItem {
  configPath: string;
  outputDir?: string;
  result?: EvaluationRunResult;
  error?: string;
  skipped?: boolean;
}

/** Result contract for a batch implementation. */
export interface EvaluationBatchResult {
  items: EvaluationBatchItem[];
  passed: number;
  failed: number;
  skipped: number;
}

/** Public result-summary extension point. */
export interface EvalSummaryGenerator {
  generate(summary: EvaluationSummary): Promise<string>;
}
