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
  GraderType,
  GraderScore,
  GraderScoreMap,
  GraderBreakdown,
  UsageMetrics,
  ClientDiagnostics,
  MCPProtocolInfo,
  SkillLoad,
} from './index.js';
import type { EvalResultStoreLike } from '../evals/resultStore.js';
import type { TraceEvidence, Trace } from '../evals/evalFrameworkTypes.js';
import type { ClientMetadata } from '../evals/externalClient/types.js';

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
 * Optimization tracking metadata for an eval run
 */
export interface EvalRunMetadata {
  /** Git commit hash at time of run */
  gitHash?: string;
  /** ISO timestamp of the run */
  timestamp: string;
  /** Package version from package.json */
  packageVersion: string;
  /** Runtime tool override variant identifier, when one was used */
  toolVariantId?: string;
  /** The model client cases ran on, when the run named it. */
  model?: string;
  /** Judge model identifier (if judge was used) */
  judgeModel?: string;
  /**
   * Protocol the run's MCP connection requested and negotiated. Results from
   * different eras are not directly comparable.
   */
  protocol?: MCPProtocolInfo;
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

  /**
   * Requirement level. A failing 'should' check is a warning: it is reported
   * but does not fail the conformance result. Absent means 'must'.
   */
  severity?: ConformanceSeverity;

  /**
   * True when the check did not run (not applicable to this server, era, or
   * transport). Skipped checks never fail the result; `message` says why.
   */
  skipped?: boolean;

  /**
   * Protocol revision the check validates against (e.g. '2026-07-28').
   */
  specVersion?: string;

  /**
   * Where the requirement comes from, e.g. a spec section or an official
   * conformance eval requirement ID.
   */
  specRef?: string;
}

/**
 * Conformance requirement level: 'must' (fails the result) or 'should'
 * (reported as a warning).
 */
export type ConformanceSeverity = 'must' | 'should';

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
   * Protocol the checked connection requested and negotiated
   */
  protocol?: MCPProtocolInfo;

  /**
   * Label for results that span connections (e.g. 'cross-era: legacy ↔
   * 2026-07-28'). The report groups by this instead of `protocol` when set.
   */
  scope?: string;

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
 * Result of a single trial within a multi-trial eval case
 */
export interface TrialResult {
  /** Whether this trial passed */
  pass: boolean;
  /** Each grader's score for this trial, by grader type. */
  scores?: GraderScoreMap;
  /** Execution time for this trial */
  durationMs: number;
  /** Error message if the trial failed with an exception */
  error?: string;
  /** When true, this trial failed due to network/infrastructure issues rather than an assertion failure */
  isInfrastructureError?: boolean;
  /**
   * Ordered trace of tool calls the client made in this trial (client cases only).
   * Captures what was actually called so you can distinguish "LLM didn't call the tool"
   * from "LLM called the wrong tool" from "tool was called but assertion failed".
   */
  toolCallTrace?: {
    calls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      status: 'expected' | 'unexpected';
    }>;
    missed: Array<{ name: string }>;
  };
  /** Sanitized client evidence for this specific trial. */
  clientDiagnostics?: ClientDiagnostics;
  /** Evidence level retained even when raw responses are redacted. */
  traceEvidence?: TraceEvidence;
  /** What the client did in this trial. */
  trace?: Trace;
  /** Token usage from the client's model calls in this trial */
  clientUsage?: UsageMetrics;
  /** Token usage of this trial's judges, from judges that report it. */
  judgeUsage?: Partial<UsageMetrics>;
  /** Skills the `mst` client loaded in this trial (skills enabled). */
  skillLoads?: SkillLoad[];
  /** The client's native numeric measurements, retained after response redaction. */
  clientTelemetry?: Record<string, unknown>;
  /** How a desktop client was driven and observed in this trial. */
  clientMetadata?: ClientMetadata;
}

/**
 * Request data captured from the eval case input.
 * Preserves what was sent so results are self-contained for debugging.
 */
export interface EvalCaseRequest {
  /** Human-readable description of the case */
  description?: string;
  /** Runtime tool override variant identifier, when one was used */
  toolVariantId?: string;

  /** Number of trials configured for this case */
  trials?: number;

  /** Pass threshold configured for this case */
  passThreshold?: number;

  /** Judge repetitions configured for this case */
  judgeReps?: number;

  /** Tags from the source eval case */
  tags?: string[];

  /** Configured assertions, sanitized for reporter output */
  assertions?: Record<string, unknown>;

  /** The judges the case ran (its own and the eval config's), sanitized for reporter output */
  judges?: Array<string | Record<string, unknown>>;

  /** Tool arguments, for a tool call the reporter tracked in a Playwright test */
  args?: Record<string, unknown>;

  // Client case fields
  /** The input sent to the client as its prompt */
  input?: string;
  /** Golden/reference answer associated with the case, when supplied. */
  reference?: string;
  /** The client the case ran on, when the run or the case named it. */
  client?: string;
  /** The model the client used, when the run or the case named it. */
  model?: string;
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
   * The MCP tool a Playwright test called, for a tool call the reporter
   * tracked. Eval case results don't have one: see `request.client`.
   */
  toolName?: string;

  /**
   * Source of this result
   */
  source: ResultSource;

  /**
   * Overall pass/fail status
   */
  pass: boolean;

  /**
   * What the case asked for: its input, client, model and assertions.
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
   * Grader scores, by grader type
   */
  scores: Partial<Record<GraderType, GraderScore>>;

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
   * Assertion pass rate (0–1): passes divided by non-infrastructure trials.
   * Only present when the case was run with `trials > 1`.
   *
   * Infrastructure errors (network timeouts, rate limits, etc.) are excluded from
   * the denominator so that environment reliability does not inflate this metric.
   */
  passRate?: number;

  /**
   * 95% Wilson score confidence interval for `passRate`.
   * Only present when the case was run with `trials > 1`.
   *
   * Interpet as: the true pass rate is likely between `lower` and `upper`.
   * Wider intervals mean fewer trials were run; run more trials to narrow them.
   *
   * @example { lower: 0.35, upper: 0.93 } // 7/10 passes → 70% ± wide CI
   * @example { lower: 0.57, upper: 0.80 } // 35/50 passes → 70% ± narrow CI
   */
  passRateCI?: {
    /** Lower bound of the 95% confidence interval (0–1) */
    lower: number;
    /** Upper bound of the 95% confidence interval (0–1) */
    upper: number;
  };

  /**
   * Infrastructure error rate (0–1): infra errors divided by total trials.
   * Only present when the case was run with `trials > 1`.
   */
  infrastructureErrorRate?: number;

  /**
   * Per-trial pass/fail breakdown.
   * Only present when the case was run with `trials > 1`.
   */
  trialResults?: Array<TrialResult>;

  /**
   * Tags from the source eval case, for filtering and slicing reports.
   */
  tags?: string[];

  /**
   * Precision of tool calls made (0–1).
   * 1.0 means every tool called was expected; <1.0 means unexpected tools were called.
   * Populated whenever a `toolsTriggered` assertion is evaluated.
   */
  toolPrecision?: number;

  /**
   * Recall of required tool calls (0–1).
   * 1.0 means all required tools were called; <1.0 means some were missed.
   * Only populated when toolsTriggered assertion was evaluated.
   */
  toolRecall?: number;

  /**
   * Pass/fail status of this case in the baseline run.
   * Only present when a baseline was provided to runEvalDataset.
   */
  baselinePass?: boolean;

  /**
   * Number of trials that failed due to infrastructure errors (network, rate limits, etc.)
   * Only present when the case was run with `trials > 1`.
   */
  infrastructureErrorCount?: number;

  /**
   * Ordered trace of tool calls the client made.
   * Only populated when the eval case uses toolsTriggered assertions.
   */
  toolCallTrace?: {
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

  /** Sanitized client evidence; each trial retains its own diagnostics. */
  clientDiagnostics?: ClientDiagnostics;
  /** Evidence level retained in persisted comparisons after response redaction. */
  traceEvidence?: TraceEvidence;
  /**
   * What the client did (client cases with one trial). With several
   * trials, each one's trace is in `trialResults`.
   */
  trace?: Trace;
  /** The eval variant that produced this result. */
  variant?: string;

  /**
   * Aggregate token usage from the client's model calls for this case.
   * Summed across all trials. Only populated for client cases.
   */
  clientUsage?: UsageMetrics;
  /**
   * Token usage of the case's judges, from judges that report it.
   * Summed across all trials.
   */
  judgeUsage?: Partial<UsageMetrics>;
  /** Native single-trial measurements; multi-trial values live in trialResults. */
  clientTelemetry?: Record<string, unknown>;

  /**
   * External client trace and evidence metadata.
   * Populated for clients that drive a desktop app, such as ChatGPT.
   */
  clientMetadata?: ClientMetadata;
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
     * Grader type breakdown
     */
    graderBreakdown: GraderBreakdown;

    /**
     * Aggregate token usage from every client case's model calls in this run.
     */
    totalClientUsage?: UsageMetrics;
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
   * Summary of a tool-metadata tool optimization (runToolOptimization),
   * present when the run was produced by one. The `results` above reflect the
   * winning variant; this records how the optimization got there.
   */
  toolOptimization?: MCPToolOptimizationData;
}

/**
 * Compact summary of a `runToolOptimization` run, for the reporter UI.
 */
export interface MCPToolOptimizationData {
  /** Metric optimized: passRate | toolF1 | toolPrecision | toolRecall. */
  metric: string;
  /** Baseline metric value (0-1), before any variant. */
  baselineValue: number;
  /** Best metric value achieved (the winner, or the best candidate tried) (0-1). */
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
  /** Why the optimization stopped. */
  reason: string;
  /**
   * Case-by-case comparison of every variant against the baseline, computed
   * by `compareVariants`. Absent in reports written before 2.0.
   */
  comparison?: MCPComparisonData;
}

/**
 * Which cases a variant is judged on.
 *
 * - `capability`: a capability case, which a variant should improve.
 * - `regression`: a regression case, which a variant must not break.
 *
 * Groups never come from the baseline run the variants are compared with:
 * picking cases by that run's own results and then measuring change against
 * it builds in regression to the mean. See `VariantGrouping`.
 */
export type VariantCaseGroup = 'capability' | 'regression';

/**
 * Where the case groups came from.
 *
 * - `declared`: cases with the regression tag are regression cases; every
 *   other case is a capability case.
 * - `grouping-run`: no case had the regression tag, so the optimization ran
 *   the baseline once more, only to group cases: those that passed it are
 *   regression cases.
 */
export type VariantGrouping = 'declared' | 'grouping-run';

/** The library's call on a change: clearly better, clearly worse, or neither. */
export type ChangeAssessment = 'better' | 'worse' | 'unclear';

/**
 * What went wrong in a failed trial, read from its tool-call trace.
 *
 * - `no-tool-call`: the client called no tools.
 * - `wrong-tool`: the client called an unexpected tool or missed a required one.
 * - `check-failed`: the expected tools were called, but an assertion failed.
 * - `error`: the trial threw, or failed for an infrastructure reason.
 */
export type TrialFailureKind =
  | 'no-tool-call'
  | 'wrong-tool'
  | 'check-failed'
  | 'error';

/**
 * Mean per-case difference between a variant and the baseline, as a share
 * (0.25 = 25 points).
 *
 * `lower` and `upper` are a 95% t-interval over cases, for display. With
 * fewer than two cases the interval spans every possible value (-1 to 1).
 * The assessment comes from an exact paired sign-flip test instead, which stays
 * valid with few cases; with one trial per case it is McNemar's exact test.
 */
export interface PairedChange {
  mean: number;
  lower: number;
  upper: number;
  /** Cases the difference was taken over. */
  cases: number;
  /** One-sided p-value that the variant is better than the baseline. */
  pBetter: number;
  /** One-sided p-value that the variant is worse than the baseline. */
  pWorse: number;
  /**
   * `better` when `pBetter` is below `alpha / variantsTried`, `worse` when
   * `pWorse` is below `alpha`, otherwise `unclear`.
   */
  assessment: ChangeAssessment;
}

/** A variant's results over one case group. */
export interface VariantGroupStats {
  /** Cases in the group. */
  cases: number;
  /** Mean per-case pass rate (pass@1). Absent when the group is empty. */
  passRate?: number;
  /** Pass rate over cases without the held-out tag, when the group has both kinds. */
  seenPassRate?: number;
  /** Pass rate over held-out cases, when the group has any. */
  heldOutPassRate?: number;
  /** Share of the group's cases where every trial passed (pass^k). */
  allTrialsPassedRate?: number;
  /** Change from the baseline. Absent for the baseline and for empty groups. */
  change?: PairedChange;
  /**
   * Change on the group's held-out cases alone, when it has both kinds.
   * Variants are ranked without held-out cases, so this is a check the
   * selection can't have tuned to.
   */
  heldOutChange?: PairedChange;
}

/** One trial at one case by one variant. */
export interface VariantTrial {
  pass: boolean;
  /** Why the trial failed, when it did. */
  failure?: TrialFailureKind;
  /** Tools the client called, in order, when a trace was recorded. */
  calls?: string[];
  /** Required tools the client never called. */
  missed?: string[];
  /** Input plus output tokens, when the client reported usage. */
  tokens?: number;
}

/** One case's results across every variant. */
export interface VariantComparisonCase {
  id: string;
  /** The case's input (or description) given to the client. */
  input?: string;
  group: VariantCaseGroup;
  heldOut: boolean;
  /** Tools the case expects, from its `toolsTriggered` assertion. */
  expectedTools?: string[];
  /** Trials keyed by variant id (the baseline uses `baselineId`). */
  trials: Record<string, VariantTrial[]>;
}

/** One tool field a variant changed. */
export interface VariantToolChange {
  tool: string;
  field: 'description' | 'inputSchema';
  /** The server's original value, when it could be read. */
  before?: string;
  after: string;
}

/** A wrong or missing tool call that recurred across a variant's failed trials. */
export interface VariantToolMistake {
  /** The first tool called instead, or null when no tool was called. */
  called: string | null;
  /** The tools that were expected. */
  expected: string[];
  /** Whether the expected tool was called but the trial still failed. */
  calledExpected: boolean;
  trials: number;
  caseIds: string[];
}

/**
 * Where a variant landed.
 *
 * - `baseline`: the reference every variant is compared with.
 * - `recommended`: the optimization's winner.
 * - `breaks`: disqualified for breaking cases that work today.
 * - `better`: better than the baseline, but not the winner.
 * - `worse`: worse than the baseline on cases that should now work.
 * - `no-change`: no clear difference from the baseline.
 */
export type VariantStatus =
  | 'baseline'
  | 'recommended'
  | 'breaks'
  | 'better'
  | 'worse'
  | 'no-change';

/** One variant's results, including the baseline. */
export interface VariantComparisonEntry {
  id: string;
  /** The variant's own explanation of what it tests. */
  description?: string;
  status: VariantStatus;
  /**
   * The two checks a winner must pass: clearly better than the baseline,
   * after adjusting for every variant tried, and not breaking
   * `regression` cases under the optimization's rule.
   */
  checks?: { fixes: boolean; keepsRegressions: boolean };
  capability: VariantGroupStats;
  regression: VariantGroupStats;
  /** Cases that pass more trials than with the baseline. */
  improvedCaseIds: string[];
  /** Cases that pass fewer trials than with the baseline. */
  regressedCaseIds: string[];
  /**
   * `regression` cases that clearly broke on their own: a one-sided
   * Fisher's exact test on each case's trials, Holm-corrected so the
   * chance of wrongly calling any case broken stays below `caseAlpha`.
   */
  brokenCaseIds: string[];
  /** Cases that passed some trials but not all. */
  unsteadyCaseIds: string[];
  trials: number;
  failedTrials: number;
  failures: Record<TrialFailureKind, number>;
  mistakes: VariantToolMistake[];
  meanTokensPerTrial?: number;
  meanToolCallsPerTrial?: number;
  toolChanges: VariantToolChange[];
}

/**
 * How a variant is disqualified for breaking cases that work today.
 *
 * - `significant` (default): the variant is disqualified when its
 *   `regression` cases clearly got worse, as a group (paired sign-flip
 *   test, one-sided p below `alpha`) or any one case on its own (see
 *   `brokenCaseIds`). One flaky trial is not breakage.
 * - `any-case`: any case that passed with the baseline and fails with the
 *   variant disqualifies it, however small the drop. With flaky cases this
 *   rejects variants for noise.
 */
export type RegressionCheck = 'any-case' | 'significant';

/** Every variant compared with the baseline, case by case. */
export interface MCPComparisonData {
  baselineId: string;
  regressionCheck: RegressionCheck;
  /** Where the case groups came from. */
  grouping: VariantGrouping;
  /** The tag that marks a regression (`regression`) case. */
  regressionTag: string;
  /** The tag that marks a case as held out. */
  heldOutTag: string;
  /**
   * One-sided significance level for calling a change clearly better or
   * worse. 0.025 matches the 95% intervals shown.
   */
  alpha: number;
  /**
   * Variants tried across every round. A variant counts as clearly better
   * only when `pBetter` is below `alpha / variantsTried` (Bonferroni), so
   * trying many variants doesn't make a lucky one look real. 0 when none ran.
   */
  variantsTried: number;
  /** Familywise level for calling any single `regression` case broken. */
  caseAlpha: number;
  /**
   * Trials per case needed before one regression case breaking outright
   * can be detected on its own, given how many regression cases there are.
   * When `regressionTrialsPerCase` is lower, only breakage across cases
   * can be detected.
   */
  trialsToDetectBrokenCase: number;
  /** Fewest trials any regression case ran, in any variant. */
  regressionTrialsPerCase?: number;
  /** Most trials any case ran. */
  trialsPerCase: number;
  /** Fewest trials any case ran. */
  minTrialsPerCase: number;
  /** The winner, when there is one. */
  recommendedId?: string;
  /** Baseline first, then candidates in the order they ran. */
  variants: VariantComparisonEntry[];
  cases: VariantComparisonCase[];
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
