/**
 * Types for MCP Test Reporter UI
 *
 * Types the UI uses, re-exported from the canonical backend sources. When a
 * component needs another backend type, re-export it here (knip flags any
 * re-export the UI does not use).
 * esbuild inlines type imports at bundle time (stripped at runtime — zero overhead).
 */

export type {
  MCPToolOptimizationData,
  MCPComparisonData,
  VariantComparisonEntry,
  VariantComparisonCase,
  VariantTrial,
  VariantToolChange,
  VariantToolMistake,
  VariantStatus,
  TrialFailureKind,
  PairedChange,
  PassRateInterval,
  MCPRunReportData,
  RunReportDifference,
  RunReportEvent,
  RunReportJudgeCalibration,
  RunReportPreference,
  RunReportTrial,
  RunReportVariant,
  RunReportWrites,
} from '../../types/reporter.js';

export type {
  HistoryIndex,
  HistoryRun,
  HistoryVariant,
} from '../../types/history.js';

import type { MCPRunReportData } from '../../types/reporter.js';
import type { HistoryIndex } from '../../types/history.js';

declare global {
  interface Window {
    /** Set by a run's report/data.js (`mst open`). */
    MST_RUN_REPORT?: MCPRunReportData;
    /** Set by an eval's history/data.js (`mst open --history`). */
    MST_HISTORY?: HistoryIndex;
  }
}
