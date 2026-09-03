import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalRunnerResult } from '../types/index.js';
import type {
  EvalConfig,
  EvalConfigMode,
  NativeMcpServerConfig,
} from './evalConfigSchema.js';
import type {
  MCPHostConfig,
  MCPHostSimulationResult,
} from './mcpHost/mcpHostTypes.js';

/** Options shared by an evaluation-suite implementation. */
export interface EvaluationSuiteOptions {
  configPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  dryRun?: boolean;
  configOverrides?: Partial<EvalConfig>;
}

/** Stable summary shape written by a completed evaluation suite. */
export interface EvaluationSummary {
  timestamp: string;
  durationMs: number;
  configName: string;
  evalMode: EvalConfigMode | string;
  mcpUrl?: string;
  evalsetFilePaths?: string[];
  metrics: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    datasetBreakdown: Record<string, number>;
  };
  results: EvalCaseResult[];
  aggregatedMetrics?: Record<string, unknown>;
}

/** Result contract for a suite implementation. */
export interface EvaluationSuiteResult {
  config: EvalConfig;
  outputDir: string;
  datasets: Array<{
    path: string;
    name: string;
    result?: EvalRunnerResult;
  }>;
  merged: EvaluationSummary;
  comparison?: unknown[];
}

/** Options for running multiple evaluation configs. */
export interface EvaluationBatchOptions {
  configPaths?: string[];
  configDir?: string;
  rootDir?: string;
  outputRoot?: string;
  parallel?: number;
  configOverrides?: Partial<EvalConfig>;
}

/** Result contract for a batch implementation. */
export interface EvaluationBatchResult {
  runs: Array<{
    configPath: string;
    outputDir?: string;
    result?: EvaluationSuiteResult;
    error?: string;
  }>;
}

/** Framework-level metric extension point. */
export interface EvalMetricDefinition {
  readonly name: string;
  readonly kind: 'binary' | 'continuous' | 'categorical' | 'object';
  readonly unit?: string;
  compute(
    result: EvalCaseResult
  ): boolean | number | string | Record<string, number> | null;
}

/** Framework-level host extension point. */
export interface EvalHostAdapter {
  readonly name: string;
  supports(config: MCPHostConfig): boolean;
  run(
    scenario: string,
    config: MCPHostConfig
  ): Promise<MCPHostSimulationResult>;
}

/** Framework-level native-server policy extension point. */
export interface NativeMcpServerResolver {
  resolve(
    definitions: NativeMcpServerConfig[]
  ): Promise<Record<string, Record<string, unknown>>>;
}

/** Framework-level post-run summary extension point. */
export interface EvalSummaryGenerator {
  generate(summary: EvaluationSummary): Promise<string>;
}
