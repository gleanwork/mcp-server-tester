import type { EvalDataset, EvalCase } from './datasetTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalRunnerResult } from '../types/index.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type {
  DatasetConfig,
  EvalArm,
  EvalManifest,
  ExtensionConfig,
  HostConfig,
} from './evalManifest.js';
import type { EvalResultStore } from './resultStore.js';

/** Context provided to a dataset source implementation. */
export interface DatasetSourceContext {
  rootDir: string;
  manifest: EvalManifest;
}

/** Public dataset-source extension point. */
export interface DatasetSource {
  readonly name: string;
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

/** Public host extension point. */
export interface HostDefinition {
  readonly name: string;
  run(options: HostRunOptions): Promise<EvalRunnerResult>;
}

/** Values emitted by a metric for one evaluation case. */
export type MetricValue =
  boolean | number | string | Record<string, number> | null;

export type MetricKind = 'binary' | 'continuous' | 'categorical' | 'object';

/** Public metric extension point. */
export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit?: string;
  compute(caseResult: EvalCaseResult): MetricValue;
  aggregate?(values: MetricValue[], metricName: string): unknown;
}

/** Public judge extension point. */
export interface JudgeDefinition {
  readonly name: string;
  evaluate(
    candidate: unknown,
    reference?: unknown
  ): Promise<{
    score: number;
    reasoning?: string;
  }>;
}

/** Public result-store extension point. */
export interface ResultStoreDefinition {
  readonly name: string;
  create(config: ExtensionConfig): EvalResultStore;
}

/** Options shared by a manifest runner implementation. */
export interface EvaluationSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  dryRun?: boolean;
  arm?: string;
}

/** Per-arm result metadata. */
export interface EvaluationArmResult {
  name: string;
  servers: MCPConfig[];
  result?: EvalRunnerResult;
  comparison?: Record<string, unknown>;
}

/** Stable summary shape written by a completed evaluation suite. */
export interface EvaluationSummary {
  timestamp: string;
  durationMs: number;
  manifestName: string;
  arms: EvaluationArmResult[];
  metrics: Record<string, unknown>;
  results: EvalCaseResult[];
}

/** Result contract for a suite implementation. */
export interface EvaluationSuiteResult {
  manifest: EvalManifest;
  outputDir: string;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: EvalDataset;
  }>;
  summary: EvaluationSummary;
}

/** Options for running multiple evaluation manifests. */
export interface EvaluationBatchOptions {
  manifestPaths?: string[];
  manifestDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  skipExisting?: boolean;
  dryRun?: boolean;
}

/** Result contract for a batch implementation. */
export interface EvaluationBatchResult {
  runs: Array<{
    manifestPath: string;
    outputDir?: string;
    result?: EvaluationSuiteResult;
    error?: string;
  }>;
}

/** Public result-summary extension point. */
export interface EvalSummaryGenerator {
  generate(summary: EvaluationSummary): Promise<string>;
}
