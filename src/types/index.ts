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
export type { ClientDiagnostics } from './clientDiagnostics.js';
export type { InfrastructureBreak, TrialEnding } from './trialEnding.js';
import type { UsageMetrics } from '../judge/judgeTypes.js';
import type { JudgeSubScore } from '../judge/judgeContract.js';

/**
 * MCP protocol era.
 *
 * - 'legacy': revisions that open with the `initialize` handshake
 *   (`2024-10-07` through `2025-11-25`)
 * - 'modern': revisions with per-request `_meta` and `server/discover`
 *   (`2026-07-28` and later)
 */
export type ProtocolEra = 'legacy' | 'modern';

/**
 * A dated MCP protocol revision, e.g. `'2025-06-18'` or `'2026-07-28'`.
 */
export type ProtocolRevision =
  | '2024-11-05'
  | '2025-03-26'
  | '2025-06-18'
  | '2025-11-25'
  | '2026-07-28'
  | (string & {});

/**
 * Which protocol a connection should speak.
 *
 * - 'legacy' (default): the `initialize` handshake, byte-identical to MST 1.x
 * - 'auto': probe with `server/discover` and fall back to legacy
 * - a revision: pin exactly that revision; connecting fails if the server
 *   does not offer it
 */
export type ProtocolSetting = 'legacy' | 'auto' | ProtocolRevision;

/** How the simulated (SDK) client offers Agent Skills to the model. */
export type ClientSkillsMode = 'off' | 'catalog' | 'preload';

/** One skill (or skill file) the simulated client loaded for the model. */
export interface SkillLoad {
  /** Skill name (frontmatter `name`). */
  name: string;
  /** URI that was read: the skill's SKILL.md or a supporting file. */
  uri: string;
  /** Client label of the server that served it. */
  server: string;
  /** 'skill' for SKILL.md loads, 'file' for supporting files. */
  kind: 'skill' | 'file';
  /** How it reached the model. */
  via: 'read_skill' | 'read_resource' | 'preload';
  /** Result of verifying the read against the skill's entry. */
  verified: boolean | null;
  /** Verification problems or read errors; the model got an error instead. */
  problems?: string[];
  /** Number of MCP tool calls made before this load. */
  afterToolCalls: number;
}

/** Probe options for `protocol: 'auto'`. */
export interface ProtocolProbeOptions {
  /** Probe timeout in milliseconds (defaults to the connect timeout). */
  timeoutMs?: number;
}

/**
 * The protocol a connection requested and the one it actually negotiated.
 */
export interface MCPProtocolInfo {
  /** The `protocol` setting the connection was created with. */
  requested: ProtocolSetting;
  /** The revision negotiated with the server (e.g. `'2025-11-25'`). */
  negotiated: string | null;
  /** The era the connection landed on. */
  era: ProtocolEra | null;
}

/**
 * Source of test results
 *
 * - 'eval': From runEvalDataset() using JSON eval datasets
 * - 'test': From direct API test tracking (MCP fixture calls)
 */
export type ResultSource = 'eval' | 'test';

/**
 * Grader types: the assertion types and `judge` (a case's judges)
 */
export type GraderType =
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
 * A grader's score for one trial
 */
export interface GraderScore {
  /**
   * Whether the grader passed
   */
  pass: boolean;

  /**
   * Optional details about the result
   */
  details?: string;

  /**
   * Judge score (0-1). Populated for judges.
   */
  score?: number;

  /**
   * Judge reasoning. Populated for judges.
   */
  reasoning?: string;

  /**
   * Judge name — rubric name (e.g. 'correctness') or custom judge name.
   * Populated for judges.
   */
  judgeName?: string;

  /**
   * Judge provider used. Populated for judges.
   */
  judgeProvider?: string;

  /**
   * Judge model used. Populated for judges.
   */
  judgeModel?: string;

  /**
   * The identity of the judge that gave this score: a hash of the judge,
   * its version and its options (ADR 0009). Populated for judges that ran
   * or skipped; scores from before MST recorded it have none.
   */
  judgeIdentity?: string;

  /**
   * The judge has no version MST can see change: it declares none and its
   * plugin has no package version. Its identity can stay the same while it
   * grades differently, so a calibration of it can't go stale visibly.
   */
  judgeUnversioned?: true;

  /** The judge could not grade this case. Not counted in pass/fail or score metrics. */
  skipped?: boolean;

  /**
   * The judge read the trial and its trace can't support a verdict. `pass`
   * is false, because the trial didn't earn a pass, but the judge's pass
   * rate and score metrics leave it out, and `mst judges check` counts it.
   */
  unknown?: true;

  /**
   * The grader failed to run (a judge's SDK missing, its endpoint down, an
   * invalid score): no verdict on the trial. A trial with a grader error is
   * an infrastructure failure, left out of pass rates.
   */
  error?: string;

  /** Named sub-scores from the judge, such as one per rubric criterion. */
  subScores?: Record<string, JudgeSubScore>;

  /**
   * Each criterion's verdict, for a judge that checks criteria a person
   * labels one at a time (the `criteria` judge). Each is its own label
   * question, `<judge>#<id>`, with its own identity.
   */
  criteria?: GraderCriterion[];

  /**
   * Each member's verdict, for a judge run as a jury on several models.
   * The score's verdict is their majority (ADR 0009).
   */
  jury?: GraderJuryVote[];

  /** Token usage and cost of the judge's own model calls. */
  usage?: Partial<UsageMetrics>;

  /** Other structured judge output. */
  metadata?: Record<string, unknown>;

  /**
   * Per-judge breakdown when multiple judges are used.
   * Each entry contains the individual judge's result.
   * Only populated when a case runs 2+ judges.
   */
  judgeResults?: GraderScore[];
}

/** One criterion's verdict in a judge's score (ADR 0009). */
export interface GraderCriterion {
  id: string;
  /** What the criterion asks. */
  text?: string;
  /** `false` when the criterion doesn't decide the judge's pass. */
  required?: false;
  verdict: 'pass' | 'fail' | 'unknown';
  reasoning?: string;
  /**
   * The identity of the judge as it graded this criterion: its identity
   * with only this criterion in its options, so the same criterion in
   * another case shares it, and a changed criterion gets a new one.
   */
  judgeIdentity: string;
}

/** One jury member's verdict in a jury's score (ADR 0009). */
export interface GraderJuryVote {
  provider?: string;
  model?: string;
  /** The identity of the judge this member ran. */
  judgeIdentity: string;
  verdict: 'pass' | 'fail' | 'unknown' | 'skipped';
  /** The member's score, when it passed or failed. */
  score?: number;
  reasoning?: string;
}

/**
 * Map of grader type to score
 */
export type GraderScoreMap = Partial<Record<GraderType, GraderScore>>;

/**
 * How many cases used each grader type in a run
 */
export type GraderBreakdown = Partial<Record<GraderType, number>>;

export {
  SnapshotSanitizers,
  type BuiltInSanitizer,
  type FieldRemovalSanitizer,
  type JudgeMatcherOptions,
  type JudgeValidatorConfig,
  type PatternValidatorOptions,
  type PredicateResult,
  type RegexSanitizer,
  type SchemaRegistry,
  type SchemaValidatorOptions,
  type SizeValidatorOptions,
  type SnapshotMatchOptions,
  type SnapshotSanitizer,
  type SnapshotStore,
  type SnapshotValidatorOptions,
  type TextValidatorOptions,
  type ToolCallCountOptions,
  type ToolCallAssertion,
  type ToolPredicate,
  type ValidationResult,
} from './assertions.js';

export type {
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPClientCapabilities,
  MCPAuthConfig,
  MCPOAuthConfig,
  MCPClientCredentialsConfig,
} from './config.js';

export type {
  StoredTokens,
  StoredClientInfo,
  StoredOAuthState,
  OAuthSetupConfig,
  TokenResult,
  PlaywrightOAuthClientProviderConfig,
  ClientCredentialsConfig,
  ProtectedResourceMetadata,
  ProtectedResourceDiscoveryResult,
  StoredServerMetadata,
  CLIOAuthClientConfig,
  CLIOAuthResult,
} from './auth.js';

export type {
  CreateMCPClientOptions,
  ContentBlock,
  NormalizedToolResponse,
  MCPFixtureApi,
  MCPFixtureOptions,
  MCPAuthFixtures,
} from './mcp.js';

export type {
  EvalCase,
  EvalDataset,
  EvalAssertions,
  JudgeExpectConfig,
  CaseJudge,
  CaseJudgeConfig,
  SerializedEvalDataset,
  LoadDatasetOptions,
  EvalContext,
  EvalRunnerResult,
  EvalRunnerOptions,
  EvalCaseOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  SaveBaselineOptions,
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  SaveEvalRunComparisonOptions,
  StoredEvalRunRef,
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
  BaselineMeasurement,
  RegressionCheck,
  VariantGroupStats,
  PairedChange,
  ChangeAssessment,
  VariantGrouping,
  LLMProvider,
  LLMToolCall,
  MstClientSimulationResult,
} from './evals.js';

export type {
  JudgeConfig,
  Judge,
  JudgeResult,
  UsageMetrics,
  ProviderKind,
  BuiltInRubric,
  RubricSpec,
  JudgeInput,
  JudgeCase,
  JudgeCaseInput,
  JudgeExpected,
  JudgeTrial,
  JudgeMessage,
  JudgeSubScore,
} from './judge.js';

export type {
  MCPConformanceOptions,
  MCPConformanceResult,
  MCPConformanceCheck,
  MCPConformanceRaw,
} from './conformance.js';

export type {
  MCPEvalReporterConfig,
  EvalCaseRequest,
  EvalCaseResult,
  EvalRunMetadata,
  TrialResult,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
} from './reporter.js';
