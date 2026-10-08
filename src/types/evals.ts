export type {
  EvalCase,
  EvalDataset,
  EvalAssertions,
  JudgeExpectConfig,
  CaseJudge,
  CaseJudgeConfig,
  SerializedEvalDataset,
} from '../evals/datasetTypes.js';

export type { LoadDatasetOptions } from '../evals/datasetLoader.js';

export type {
  EvalCaseOptions,
  EvalContext,
  EvalRunnerResult,
  EvalRunnerOptions,
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
} from '../evals/evalRunner.js';

export type {
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  SaveEvalRunComparisonOptions,
  StoredEvalRunRef,
} from '../evals/evalRunComparison.js';

export type {
  OptimizationMetric,
  ToolOptimizationReason,
  VariantRecommendation,
  VariantCandidateResult,
  ToolOptimizationRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  ToolOptimizationOptions,
  ToolOptimizationResult,
  EvalToolOptimizationOptions,
  ToolOptimizationEval,
} from '../evals/toolOptimization.js';

export type { BaselineMeasurement } from '../evals/variantComparison.js';
export type {
  RegressionCheck,
  VariantGroupStats,
  PairedChange,
  ChangeAssessment,
  VariantGrouping,
} from './reporter.js';

export type { SaveBaselineOptions } from '../evals/baseline.js';

export type {
  LLMProvider,
  LLMToolCall,
  MstClientSimulationResult,
} from '../evals/mstClient/index.js';
