/**
 * Canonical type definitions for @gleanwork/mcp-server-tester
 *
 * This module is the single source of truth for shared types.
 * All other modules should import from here rather than defining their own.
 *
 * @packageDocumentation
 */

/**
 * Authentication type for MCP connections
 *
 * - 'oauth': Interactive OAuth 2.1 with PKCE (browser-based authentication)
 * - 'api-token': Static API token (e.g., from a dashboard or environment variable)
 * - 'none': No authentication
 */
export type AuthType = 'oauth' | 'api-token' | 'none';

/**
 * Source of test results
 *
 * - 'eval': From runEvalDataset() using JSON eval datasets
 * - 'test': From direct API test tracking (MCP fixture calls)
 */
export type ResultSource = 'eval' | 'test';

/**
 * Known expectation types supported by the framework
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
  /**
   * Whether the expectation passed
   */
  pass: boolean;

  /**
   * Optional details about the result
   */
  details?: string;

  /**
   * Judge score (0-1). Populated for passesJudge expectations.
   */
  score?: number;

  /**
   * Judge reasoning. Populated for passesJudge expectations.
   */
  reasoning?: string;

  /**
   * Judge name — rubric name (e.g. 'correctness') or custom judge name.
   * Populated for passesJudge expectations.
   */
  judgeName?: string;

  /**
   * Judge provider used. Populated for passesJudge expectations.
   */
  judgeProvider?: string;

  /**
   * Judge model used. Populated for passesJudge expectations.
   */
  judgeModel?: string;

  /**
   * Per-judge breakdown when multiple judges are used.
   * Each entry contains the individual judge's result.
   * Only populated when passesJudge is an array with 2+ entries.
   */
  judgeResults?: EvalExpectationResult[];
}

/**
 * Map of expectation type to result
 */
export type ExpectationResultMap = Partial<
  Record<ExpectationType, EvalExpectationResult>
>;

/**
 * Breakdown of expectation types used in a run
 */
export type ExpectationBreakdown = Partial<Record<ExpectationType, number>>;

// Reporter types are exported from ./reporter.js
// Import them from there to avoid circular dependencies:
//   import type { EvalCaseResult } from '../types/reporter.js';
//
// Or import everything via the package's main index.ts
