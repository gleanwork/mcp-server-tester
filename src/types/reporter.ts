/**
 * Reporter-specific type definitions
 *
 * These types are used by the MCP reporter and UI.
 *
 * @packageDocumentation
 */

import type {
  AuthType,
  ResultSource,
  ExpectationType,
  EvalExpectationResult,
  ExpectationBreakdown,
  UsageMetrics,
} from './index.js';
import type { EvalResultStoreLike } from '../evals/resultStore.js';

/**
 * Configuration options for MCP Eval Reporter
 */
export interface MCPEvalReporterConfig {
  /**
   * Output directory for reports and historical data
   * @default '.mcp-test-results'
   */
  outputDir?: string;

  /**
   * Auto-open report in browser after test run
   * @default false
   */
  autoOpen?: boolean;

  /**
   * Number of historical runs to keep
   * @default 10
   */
  historyLimit?: number;

  /**
   * Suppress console output (report still generated)
   * @default false
   */
  quiet?: boolean;

  /**
   * Include auto-tracked MCP tool calls from tests without explicit eval results.
   * When true, any test using the MCP fixture will have its tool calls
   * included in the report, even without using runEvalCase/runEvalDataset.
   * When false, only tests with explicit eval results are included.
   * @default true
   */
  includeAutoTracking?: boolean;

  /**
   * Optional external result store for durable reporter run history.
   */
  resultStore?: EvalResultStoreLike;

  /**
   * Optional run ID for externally stored reporter results.
   * Defaults to a generated timestamp-based ID.
   */
  runId?: string;

  /**
   * Extra metadata to attach to externally stored reporter results.
   */
  runMetadata?: Record<string, unknown>;

  /**
   * When true, strips response payloads before storing reporter results externally.
   * Local report output is unchanged.
   * @default true
   */
  redactStoredResponses?: boolean;
}

/**
 * Experiment tracking metadata for an eval run
 */
export interface EvalRunMetadata {
  /** Git commit hash at time of run */
  gitHash?: string;
  /** ISO timestamp of the run */
  timestamp: string;
  /** Package version from package.json */
  packageVersion: string;
  /** Runtime tool override variant identifier, when one was used */
  toolOverrideVariantId?: string;
  /** MCP host model identifier (if mcp_host mode) */
  mcpHostModel?: string;
  /** Judge model identifier (if judge was used) */
  judgeModel?: string;
}

/**
 * Individual conformance check result
 */
export interface MCPConformanceCheck {
  /**
   * Check name (e.g., 'server_info_present', 'list_tools_succeeds')
   */
  name: string;

  /**
   * Whether the check passed
   */
  pass: boolean;

  /**
   * Human-readable message describing the result
   */
  message: string;
}

/**
 * Conformance check result as stored in reporter data
 */
export interface MCPConformanceResultData {
  /**
   * Test title where conformance check was run
   */
  testTitle: string;

  /**
   * Whether all checks passed
   */
  pass: boolean;

  /**
   * Individual check results
   */
  checks: MCPConformanceCheck[];

  /**
   * Server info if available
   */
  serverInfo?: {
    name?: string;
    version?: string;
  };

  /**
   * Number of tools discovered
   */
  toolCount: number;

  /**
   * Auth type used for this check
   */
  authType?: AuthType;

  /**
   * Project name
   */
  project?: string;
}

/**
 * Server capabilities data from mcp-list-tools attachment
 */
export interface MCPServerCapabilitiesData {
  /**
   * Test title where listTools was called
   */
  testTitle: string;

  /**
   * List of tools available on the server
   */
  tools: Array<{
    name: string;
    description?: string;
  }>;

  /**
   * Total number of tools
   */
  toolCount: number;

  /**
   * Auth type used for this test
   */
  authType?: AuthType;

  /**
   * Project name
   */
  project?: string;
}

/**
 * Result of a single iteration within a multi-iteration eval case
 */
export interface IterationResult {
  /** Whether this iteration passed */
  pass: boolean;
  /** Execution time for this iteration */
  durationMs: number;
  /** Error message if the iteration failed with an exception */
  error?: string;
  /** When true, this iteration failed due to network/infrastructure issues rather than an assertion failure */
  isInfrastructureError?: boolean;
  /**
   * Ordered trace of tool calls made by the LLM during this iteration (mcp_host mode only).
   * Captures what was actually called so you can distinguish "LLM didn't call the tool"
   * from "LLM called the wrong tool" from "tool was called but assertion failed".
   */
  mcpHostTrace?: {
    calls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      status: 'expected' | 'unexpected';
    }>;
    missed: Array<{ name: string }>;
  };
  /** Token usage from mcp_host LLM simulation in this iteration */
  hostUsage?: UsageMetrics;
}

/**
 * Request data captured from the eval case input.
 * Preserves what was sent so results are self-contained for debugging.
 */
export interface EvalCaseRequest {
  /** Human-readable description of the case */
  description?: string;
  /** Runtime tool override variant identifier, when one was used */
  toolOverrideVariantId?: string;

  // Direct mode fields
  /** Tool arguments (direct mode) */
  args?: Record<string, unknown>;

  // mcp_host mode fields
  /** Natural language scenario sent to the LLM (mcp_host mode) */
  scenario?: string;
  /** LLM provider/model configuration (mcp_host mode) */
  mcpHostConfig?: {
    provider?: string;
    model?: string;
  };
}

/**
 * Result of a single eval case
 */
export interface EvalCaseResult {
  /**
   * Case ID
   */
  id: string;

  /**
   * Dataset name this case belongs to
   */
  datasetName: string;

  /**
   * MCP tool name that was called
   */
  toolName: string;

  /**
   * Source of this result
   */
  source: ResultSource;

  /**
   * Overall pass/fail status
   */
  pass: boolean;

  /**
   * Request data from the eval case input (tool args, scenario, LLM config).
   * Populated so results are self-contained for debugging without the original dataset.
   */
  request?: EvalCaseRequest;

  /**
   * Tool response
   */
  response?: unknown;

  /**
   * Error if tool call failed
   */
  error?: string;

  /**
   * Expectation results
   */
  expectations: Partial<Record<ExpectationType, EvalExpectationResult>>;

  /**
   * Authentication type used for this test
   */
  authType?: AuthType;

  /**
   * Playwright project name this test belongs to
   */
  project?: string;

  /**
   * Execution time in milliseconds
   */
  durationMs: number;

  /**
   * Assertion pass rate (0–1): passes divided by non-infrastructure iterations.
   * Only present when the case was run with `iterations > 1`.
   *
   * Infrastructure errors (network timeouts, rate limits, etc.) are excluded from
   * the denominator so that environment reliability does not inflate this metric.
   */
  assertionPassRate?: number;

  /**
   * 95% Wilson score confidence interval for `assertionPassRate`.
   * Only present when the case was run with `iterations > 1`.
   *
   * Interpet as: the true pass rate is likely between `lower` and `upper`.
   * Wider intervals mean fewer iterations were run; run more iterations to narrow them.
   *
   * @example { lower: 0.35, upper: 0.93 } // 7/10 passes → 70% ± wide CI
   * @example { lower: 0.57, upper: 0.80 } // 35/50 passes → 70% ± narrow CI
   */
  assertionPassRateCI?: {
    /** Lower bound of the 95% confidence interval (0–1) */
    lower: number;
    /** Upper bound of the 95% confidence interval (0–1) */
    upper: number;
  };

  /**
   * Infrastructure error rate (0–1): infra errors divided by total iterations.
   * Only present when the case was run with `iterations > 1`.
   */
  infrastructureErrorRate?: number;

  /**
   * Per-iteration pass/fail breakdown.
   * Only present when the case was run with `iterations > 1`.
   */
  iterationResults?: Array<IterationResult>;

  /**
   * Tags from the source eval case, for filtering and slicing reports.
   */
  tags?: string[];

  /**
   * Precision of tool calls made (0–1).
   * 1.0 means every tool called was expected; <1.0 means unexpected tools were called.
   * Populated whenever a `toolsTriggered` expectation is evaluated.
   */
  toolPrecision?: number;

  /**
   * Recall of required tool calls (0–1).
   * 1.0 means all required tools were called; <1.0 means some were missed.
   * Only populated when toolsTriggered expectation was evaluated.
   */
  toolRecall?: number;

  /**
   * Pass/fail status of this case in the baseline run.
   * Only present when a baseline was provided to runEvalDataset.
   */
  baselinePass?: boolean;

  /**
   * Number of iterations that failed due to infrastructure errors (network, rate limits, etc.)
   * Only present when the case was run with `iterations > 1`.
   */
  infrastructureErrorCount?: number;

  /**
   * Ordered trace of tool calls made by the LLM in mcp_host mode.
   * Only populated when the eval case uses toolsTriggered expectations.
   */
  mcpHostTrace?: {
    /** The ordered sequence of tool calls made by the LLM */
    calls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      /** 'expected' = was in the expected set, 'unexpected' = was not expected */
      status: 'expected' | 'unexpected';
    }>;
    /** Tools that were required but never called */
    missed: Array<{
      name: string;
    }>;
  };

  /**
   * Aggregate token usage from mcp_host LLM simulation for this case.
   * Summed across all iterations. Only populated for mcp_host mode cases.
   */
  hostUsage?: UsageMetrics;
}

/**
 * Aggregated MCP eval run data
 */
export interface MCPEvalRunData {
  /**
   * Run timestamp (ISO 8601)
   */
  timestamp: string;

  /**
   * Total duration in milliseconds
   */
  durationMs: number;

  /**
   * Environment info
   */
  environment: {
    ci: boolean;
    node: string;
    platform: string;
  };

  /**
   * Aggregate metrics
   */
  metrics: {
    /**
     * Total number of eval cases
     */
    total: number;

    /**
     * Number of passed cases
     */
    passed: number;

    /**
     * Number of failed cases
     */
    failed: number;

    /**
     * Pass rate (0-1)
     */
    passRate: number;

    /**
     * Dataset breakdown: dataset name -> count
     */
    datasetBreakdown: Record<string, number>;

    /**
     * Expectation type breakdown
     */
    expectationBreakdown: ExpectationBreakdown;

    /**
     * Aggregate token usage from all mcp_host LLM simulations in this run.
     */
    totalHostUsage?: UsageMetrics;
  };

  /**
   * All eval results from this run
   */
  results: EvalCaseResult[];

  /**
   * Conformance check results (optional)
   */
  conformanceChecks?: MCPConformanceResultData[];

  /**
   * Server capabilities discovered via listTools (optional)
   */
  serverCapabilities?: MCPServerCapabilitiesData[];

  /**
   * Summary of a tool-metadata variant experiment (runVariantExperiment),
   * present when the run was produced by one. The `results` above reflect the
   * winning variant; this records how the experiment got there.
   */
  variantExperiment?: MCPVariantExperimentData;
}

/**
 * Compact summary of a `runVariantExperiment` run, for the reporter UI.
 */
export interface MCPVariantExperimentData {
  /** Metric optimized: passRate | toolF1 | toolPrecision | toolRecall. */
  metric: string;
  /** Baseline metric value (0-1), before any variant. */
  baselineValue: number;
  /** Best metric value achieved (the winner, or best attempt) (0-1). */
  bestValue: number;
  /** The best candidate from each round, in order. */
  rounds: Array<{
    round: number;
    variantId: string;
    metricValue: number;
    metricDelta: number;
    disqualified: boolean;
  }>;
  /** Winning variant id, if a non-regressing candidate beat the baseline. */
  winnerVariantId?: string;
  /** apply | reject | inconclusive */
  recommendation?: string;
  /** Why the experiment stopped. */
  reason: string;
}

/**
 * Historical summary for trend charts
 */
export interface MCPEvalHistoricalSummary {
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
}

/**
 * Complete data structure passed to UI
 */
export interface MCPEvalData {
  runData: MCPEvalRunData;
  historical: MCPEvalHistoricalSummary[];
}
