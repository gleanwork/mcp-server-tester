import type { ZodType } from 'zod';
import type { EvalDataset, EvalCase } from './datasetTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type {
  DatasetConfig,
  EvalArm,
  EvalManifest,
  ExtensionConfig,
  HostConfig,
} from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import type { EvalResultStore } from './resultStore.js';
import type { EvalRunnerResult } from './evalRunner.js';

/** Context provided to a dataset source implementation. */
export interface DatasetSourceContext {
  rootDir: string;
  manifest: EvalManifest;
  /** Resolved built-in host config for legacy dataset normalization. */
  hostConfig?: MCPHostConfig;
}

/** Public dataset-source extension point. */
export interface DatasetSource {
  readonly name: string;
  readonly schema: ZodType;
  load(
    config: DatasetConfig,
    context: DatasetSourceContext
  ): Promise<EvalDataset>;
}

/** Options supplied to a registered host implementation. */
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
  scenario: string;
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
  kind: 'tool_call' | 'skill' | 'command' | 'subagent';
  source: 'mcp' | 'host';
  name: string;
  server?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  id?: string;
}

/** One execution trace. Hosts never return evaluation verdicts. */
export interface HostRunResult {
  finalText: string;
  events: HostEvent[];
  error?: string;
  usage?: UsageMetrics;
}

/** Public host extension point. */
export interface HostDefinition {
  readonly name: string;
  readonly schema: ZodType;
  createConfig?(options?: Record<string, unknown>): MCPHostConfig;
  /** Missing evidence declarations are treated as unverified. */
  readonly evidence?: HostEvidence;
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
  readonly name: string;
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

/** Public judge extension point. */
export interface JudgeDefinition {
  readonly name: string;
  readonly schema: ZodType;
  evaluate: (
    candidate: unknown,
    reference?: unknown,
    /** Options parsed by this judge's schema, including defaults/transforms. */
    options?: Record<string, unknown>
  ) => Promise<{
    score: number;
    reasoning?: string;
  }>;
}

/** Public result-store extension point. */
export interface ResultStoreDefinition {
  readonly name: string;
  readonly schema: ZodType;
  create(config: ExtensionConfig): EvalResultStore;
}

/** Options shared by a manifest runner implementation. */
export interface EvaluationSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  pluginPaths?: string[];
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
  metrics?: Record<string, unknown>;
  comparison?: Record<string, unknown>;
}

/** Stable summary shape written by a completed evaluation suite. */
export interface RunTelemetry {
  cases: number;
  toolCalls: number;
  failedCases: number;
  totalHostUsage?: Partial<UsageMetrics>;
}

export interface RunSummary {
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
  pluginPaths?: string[];
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
