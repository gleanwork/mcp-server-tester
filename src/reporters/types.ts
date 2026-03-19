/**
 * Reporter types - re-exported from canonical source
 *
 * This module re-exports types from the canonical types module for backwards compatibility.
 * All type definitions now live in src/types/.
 *
 * @packageDocumentation
 */

// Re-export reporter types from canonical source
export type {
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  EvalCaseRequest,
  EvalCaseResult,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPEvalData,
} from '../types/reporter.js';

// Re-export core types
export type {
  AuthType,
  ExpectationType,
  EvalExpectationResult,
  ExpectationBreakdown,
} from '../types/index.js';

// Re-export conformance check type
export type { MCPConformanceCheck } from '../types/reporter.js';

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
}
