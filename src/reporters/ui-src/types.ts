/**
 * Types for MCP Test Reporter UI
 *
 * Types the UI uses, re-exported from the canonical backend sources. When a
 * component needs another backend type, re-export it here (knip flags any
 * re-export the UI does not use).
 * esbuild inlines type imports at bundle time (stripped at runtime — zero overhead).
 */

export type { GraderType, SkillLoad } from '../../types/index.js';

export type {
  MCPConformanceCheck,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPToolOptimizationData,
  MCPComparisonData,
  VariantComparisonEntry,
  VariantComparisonCase,
  VariantTrial,
  VariantToolChange,
  VariantStatus,
  TrialFailureKind,
  PairedChange,
  EvalCaseResult,
  MCPEvalHistoricalSummary,
  MCPEvalData,
} from '../../types/reporter.js';

import type { MCPEvalData } from '../../types/reporter.js';

declare global {
  interface Window {
    MCP_EVAL_DATA: MCPEvalData;
  }
}
