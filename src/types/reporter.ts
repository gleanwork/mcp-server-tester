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
} from './index.js';

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
