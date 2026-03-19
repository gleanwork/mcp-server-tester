/**
 * Types for MCP Test Reporter UI
 *
 * All types are re-exported from the canonical backend sources.
 * esbuild inlines type imports at bundle time (stripped at runtime — zero overhead).
 */

export type {
  AuthType,
  ResultSource,
  ExpectationType,
  EvalExpectationResult,
  ExpectationBreakdown,
} from '../../types/index.js';

export type {
  MCPConformanceCheck,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  EvalCaseRequest,
  EvalCaseResult,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPEvalData,
} from '../../types/reporter.js';

declare global {
  interface Window {
    MCP_EVAL_DATA: MCPEvalData;
  }
}
