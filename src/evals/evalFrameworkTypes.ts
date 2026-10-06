import type { Plugin } from '../plugins/plugin.js';
import type { ZodType } from 'zod';
import type { EvalDataset, EvalCase } from './datasetTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { HostDiagnostics, UsageMetrics } from '../types/index.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type {
  DatasetConfig,
  EvalArm,
  EvalManifest,
  ExtensionConfig,
  HostConfig,
  ModelPricing,
} from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import type { EvalResultStore } from './resultStore.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { JudgeInput, JudgeVerdict } from '../judge/judgeContract.js';

/** Context provided to a dataset source implementation. */
export interface DatasetSourceContext {
  rootDir: string;
  /** The manifest's directory; relative paths resolve here before `rootDir`. */
  manifestDir?: string;
  manifest: EvalManifest;
  /** Resolved built-in host config for legacy dataset normalization. */
  hostConfig?: MCPHostConfig;
}

/** Public dataset-source extension point. */
export interface DatasetSource {
  readonly schema: ZodType;
  load(
    config: DatasetConfig,
    context: DatasetSourceContext
  ): Promise<EvalDataset>;
}

/** Options supplied to a host implementation. */
export interface HostRunOptions {
  dataset: EvalDataset;
  cases: EvalCase[];
  servers: MCPConfig[];
  host: HostConfig;
  manifest: EvalManifest;
  arm?: EvalArm;
  dryRun?: boolean;
}

export interface HostRunInput {
  /** The case's input, sent to the host as its prompt. */
  prompt: string;
  servers: MCPConfig[];
  /** Execution-local environment; never persisted. */
  env?: Record<string, string | undefined>;
}

export interface HostRunContext {
  manifest: EvalManifest;
  arm?: EvalArm;
  /** Runtime-only environment isolated per suite. */
  env?: Record<string, string | undefined>;
  /** Optional compatibility settings for existing SDK/CLI case configurations. */
  mcpHostConfig?: MCPHostConfig;
}

export type HostEvidence = 'structured' | 'observed' | 'none';
export interface HostEvent {
  /**
   * `tool_call` for MCP and host tools; host-native `skill` loads, `command`
   * runs, `subagent` starts, and `tool_search` catalog searches.
   */
  kind: 'tool_call' | 'skill' | 'command' | 'subagent' | 'tool_search';
  source: 'mcp' | 'host';
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

/** One execution trace. Hosts never return evaluation verdicts. */
export interface HostRunResult {
  diagnostics?: HostDiagnostics;
  finalText: string;
  events: HostEvent[];
  error?: string;
  usage?: UsageMetrics;
  /** Native and driver observations remain separately scoped; UI actions are not LLM usage. */
  telemetry?: Record<string, unknown>;
  /** Per-request wall time, excluding shared batch setup and cleanup. */
  durationMs?: number;
  llmDurationMs?: number;
}

/**
 * What a host did in one trial: the `HostRunResult` it returned, without
 * telemetry and diagnostics, plus the evidence it declared. Case results keep
 * it for host cases (one per iteration). In a suite, every MCP event names its
 * `server` label. Stored results drop `finalText` and event `output`, which
 * can hold data from the server under test.
 */
export type HostTrace = Pick<HostRunResult, 'events' | 'usage' | 'error'> & {
  finalText?: string;
  /** Declared evidence; absent for the legacy simulated host. */
  evidence?: HostEvidence;
};

export interface HostBatchRequest {
  caseId: string;
  /** Which trial of the case this is, from 0. */
  trial: number;
  input: HostRunInput;
  config: HostConfig;
}

/** Public host extension point. */
export interface HostDefinition {
  readonly schema: ZodType;
  createConfig?(options?: Record<string, unknown>): MCPHostConfig;
  /** Missing evidence declarations are treated as unverified. */
  readonly evidence?: HostEvidence;
  /**
   * The host shows the model an arm's `toolOverrides` (read from
   * `context.arm` or `context.manifest`). Without it, a manifest that sets
   * them for this host fails validation. Hosts with only `createConfig` run
   * through MST's SDK host, which applies them.
   */
  readonly toolOverrides?: boolean;
  /**
   * For hosts with `run` or `runBatch` that don't set `toolOverrides`: the
   * host connects to the servers in `input.servers`, so the suite can serve
   * it an arm's tool variant through a local MCP proxy (the default). Set
   * false for a host that connects elsewhere; a manifest that gives it
   * `toolOverrides` then fails validation.
   */
  readonly toolSurfaceProxy?: boolean;
  /** The most cases the host can run at once; `concurrency` above it is an error. */
  readonly maxConcurrency?: number;
  /** Ordered traces for all selected iterations. The framework owns verdicts. */
  runBatch?(
    requests: HostBatchRequest[],
    context: HostRunContext
  ): Promise<HostRunResult[]>;
  run?(
    input: HostRunInput,
    config: HostConfig,
    context: HostRunContext
  ): Promise<HostRunResult>;
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

export type { JudgeVerdict } from '../judge/judgeContract.js';

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
  ) => Promise<JudgeVerdict>;
}

/** Public result-store extension point. */
export interface ResultStoreDefinition {
  readonly schema: ZodType;
  create(config: ExtensionConfig): EvalResultStore;
}

/** Options shared by a manifest runner implementation. */
export interface EvaluationSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  /** Plugin specifiers, added to the manifest's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to the manifest's `plugins`. */
  plugins?: readonly Plugin[];
  outputDir?: string;
  secretsFile?: string;
  dryRun?: boolean;
  arm?: string;
}

/** Per-arm result metadata. */
export interface EvaluationArmResult {
  name: string;
  servers: MCPConfig[];
  result?: EvalRunnerResult;
  /** Outcomes, calls, tokens, cost and time, plus the listed metrics. */
  metrics?: Record<string, unknown>;
  /** The weakest evidence among the arm's cases. */
  evidence?: HostEvidence;
  /** Listed metrics with no value for this arm (unavailable, not zero). */
  unavailableMetrics?: string[];
  /** Where `cost_usd` comes from: hosts, the manifest's `pricing`, or both. */
  costSource?: 'host' | 'pricing' | 'mixed';
  /** The prices the arm's estimates used, by model, so they can be audited later. */
  pricing?: Record<string, ModelPricing>;
  /** Models whose usage had no reported cost and no price: `cost_usd` leaves them out. */
  unpricedModels?: string[];
  comparison?: Record<string, unknown>;
}

/** Stable summary shape written by a completed evaluation suite. */
export interface RunTelemetry {
  cases: number;
  toolCalls: number;
  failedCases: number;
  totalHostUsage?: Partial<UsageMetrics>;
  /** Judge model usage, from judges that report it. Separate from host usage. */
  totalJudgeUsage?: Partial<UsageMetrics>;
}

/** How one arm changed since the previous run of the same manifest. */
export interface PreviousRunArm {
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

/** This run compared with the previous run of the same manifest. */
export interface PreviousRunComparison {
  /** The previous run's `runId`. */
  runId: string;
  timestamp: string;
  /** Whether the manifest was unchanged (`contentHash`; datasets aren't hashed). */
  sameManifest: boolean;
  passRate: number;
  passRateDelta: number;
  /** Arms present in both runs, by name. */
  arms: Record<string, PreviousRunArm>;
}

export interface RunSummary {
  /** This run's ID: its result store artifact ID and output directory name. */
  runId?: string;
  /** This run compared with the previous run of the same manifest, if there is one. */
  previousRun?: PreviousRunComparison;
  schemaVersion: 1;
  manifestId: string;
  contentHash: string;
  timestamp: string;
  durationMs: number;
  manifestName: string;
  arms: EvaluationArmResult[];
  metrics: Record<string, unknown>;
  telemetry?: RunTelemetry;
  armDeltas: Record<string, Record<string, unknown>>;
  caseArtifactPointers?: Record<string, string[]>;
  results: EvalCaseResult[];
}

export type EvaluationSummary = RunSummary;

/** Result contract for a suite implementation. */
export interface EvaluationSuiteResult {
  manifest: EvalManifest;
  outputDir: string;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: EvalDataset;
    result?: EvalRunnerResult;
  }>;
  summary: EvaluationSummary;
}

/** Options for running multiple evaluation manifests. */
export interface EvaluationBatchOptions {
  /** Explicit paths take precedence over manifestDir when nonempty. */
  manifestPaths?: string[];
  manifestDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  skipExisting?: boolean;
  secretsFile?: string;
  /** Plugin specifiers, added to each manifest's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to each manifest's `plugins`. */
  plugins?: readonly Plugin[];
  dryRun?: boolean;
}

export interface EvaluationBatchItem {
  manifestPath: string;
  outputDir?: string;
  result?: EvaluationSuiteResult;
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
