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
export type { ClientDiagnostics } from './hostDiagnostics.js';
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

/** How the simulated (SDK) host offers Agent Skills to the model. */
export type ClientSkillsMode = 'off' | 'catalog' | 'preload';

/** One skill (or skill file) the simulated host loaded for the model. */
export interface SkillLoad {
  /** Skill name (frontmatter `name`). */
  name: string;
  /** URI that was read: the skill's SKILL.md or a supporting file. */
  uri: string;
  /** Host label of the server that served it. */
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

  /** The judge could not grade this case. Not counted in pass/fail or score metrics. */
  skipped?: boolean;

  /** Named sub-scores from the judge, such as one per rubric criterion. */
  subScores?: Record<string, JudgeSubScore>;

  /** Token usage and cost of the judge's own model calls. */
  usage?: Partial<UsageMetrics>;

  /** Other structured judge output. */
  metadata?: Record<string, unknown>;

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
  type ToolCallExpectation,
  type ToolPredicate,
  type ValidationResult,
} from './assertions.js';

export type {
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPHostCapabilities,
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
  SerializedEvalDataset,
  EvalMode,
  EvalDirectRequest,
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
  ExperimentMetric,
  VariantExperimentReason,
  VariantRecommendation,
  VariantCandidateResult,
  VariantExperimentRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  VariantExperimentOptions,
  VariantExperimentResult,
  SuiteVariantExperimentOptions,
  VariantExperimentSuite,
  BaselineMeasurement,
  RegressionCheck,
  VariantGroupStats,
  PairedChange,
  ChangeAssessment,
  VariantGrouping,
  HostType,
  CLIOutputFormat,
  CLIConfig,
  LLMProvider,
  MCPHostConfig,
  LLMToolCall,
  MCPHostSimulationResult,
  MCPHostSimulator,
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
  IterationResult,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPEvalData,
} from './reporter.js';
