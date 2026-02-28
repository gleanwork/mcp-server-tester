/**
 * Types for MCP Test Reporter UI
 *
 * These types align exactly with src/types/reporter.ts to ensure consistency
 * between the backend reporter and the React UI.
 *
 * @packageDocumentation
 */

/**
 * Authentication type for MCP connections
 */
export type AuthType = 'oauth' | 'api-token' | 'none';

/**
 * Source of test results
 */
export type ResultSource = 'eval' | 'test';

/**
 * Known expectation types
 */
export type ExpectationType =
  | 'exact'
  | 'schema'
  | 'textContains'
  | 'regex'
  | 'snapshot'
  | 'judge'
  | 'error'
  | 'size'
  | 'toolsTriggered'
  | 'toolCallCount';

/**
 * Result of an expectation check
 */
export interface EvalExpectationResult {
  pass: boolean;
  details?: string;
}

/**
 * Individual conformance check result
 */
export interface MCPConformanceCheck {
  name: string;
  pass: boolean;
  message: string;
}

/**
 * Conformance check result as stored in reporter data
 */
export interface MCPConformanceResultData {
  testTitle: string;
  pass: boolean;
  checks: MCPConformanceCheck[];
  serverInfo?: {
    name?: string;
    version?: string;
  };
  toolCount: number;
  authType?: AuthType;
  project?: string;
}

/**
 * Server capabilities data from mcp-list-tools attachment
 */
export interface MCPServerCapabilitiesData {
  testTitle: string;
  tools: Array<{
    name: string;
    description?: string;
  }>;
  toolCount: number;
  authType?: AuthType;
  project?: string;
}

/**
 * Result of a single eval case
 */
export interface EvalCaseResult {
  id: string;
  datasetName: string;
  toolName: string;
  source: ResultSource;
  pass: boolean;
  response?: unknown;
  error?: string;
  expectations: Partial<Record<ExpectationType, EvalExpectationResult>>;
  authType?: AuthType;
  project?: string;
  durationMs: number;
  // Multi-iteration accuracy fields
  /**
   * Assertion pass rate (0–1): passes divided by non-infrastructure iterations.
   * Infrastructure errors are excluded from the denominator.
   */
  assertionPassRate?: number;
  /** Infrastructure error rate (0–1): infra errors divided by total iterations. */
  infrastructureErrorRate?: number;
  /** Alias for assertionPassRate. Kept for backward compatibility. */
  accuracy?: number;
  iterationResults?: Array<{
    pass: boolean;
    durationMs: number;
    error?: string;
    /** When true, this iteration failed due to network/infrastructure issues rather than an assertion failure */
    isInfrastructureError?: boolean;
  }>;
  /** Number of iterations that failed due to infrastructure errors (network, rate limits, etc.) */
  infrastructureErrorCount?: number;
  /**
   * Tags from the source eval case, for filtering and slicing reports.
   */
  tags?: string[];

  /**
   * Precision of tool calls made (0–1).
   * 1.0 means every tool called was expected; <1.0 means unexpected tools were called.
   * Only populated when exclusive: true in toolsTriggered and the expectation was evaluated.
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
}

/**
 * Breakdown of expectation types used
 */
export type ExpectationBreakdown = Record<ExpectationType, number>;

/**
 * Aggregated MCP eval run data
 */
export interface MCPEvalRunData {
  timestamp: string;
  durationMs: number;
  environment: {
    ci: boolean;
    node: string;
    platform: string;
  };
  metrics: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    datasetBreakdown: Record<string, number>;
    expectationBreakdown: ExpectationBreakdown;
  };
  results: EvalCaseResult[];
  conformanceChecks?: MCPConformanceResultData[];
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

// Window interface for global data injection
declare global {
  interface Window {
    MCP_EVAL_DATA: MCPEvalData;
  }
}
