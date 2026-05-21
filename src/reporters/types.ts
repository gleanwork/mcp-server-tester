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
  MCPEvalReporterConfig,
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
