/**
 * @gleanwork/mcp-server-tester
 *
 * The core testing interface: fixtures, matchers and validators, the MCP
 * client, config, datasets and runEvalDataset, judges, conformance, and Agent
 * Skills.
 *
 * @packageDocumentation
 */

export { SnapshotSanitizers } from './types/index.js';
export type {
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPClientCapabilities,
  MCPAuthConfig,
  MCPOAuthConfig,
  MCPClientCredentialsConfig,
  StoredTokens,
  OAuthSetupConfig,
  TokenResult,
  PlaywrightOAuthClientProviderConfig,
  CLIOAuthClientConfig,
  CLIOAuthResult,
  CreateMCPClientOptions,
  ContentBlock,
  NormalizedToolResponse,
  MCPFixtureApi,
  MCPFixtureOptions,
  MCPAuthFixtures,
  ValidationResult,
  TextValidatorOptions,
  SizeValidatorOptions,
  SchemaValidatorOptions,
  PatternValidatorOptions,
  SnapshotSanitizer,
  BuiltInSanitizer,
  RegexSanitizer,
  FieldRemovalSanitizer,
  SchemaRegistry,
  SnapshotStore,
  SnapshotMatchOptions,
  SnapshotValidatorOptions,
  ToolCallAssertion,
  ToolCallCountOptions,
  JudgeValidatorConfig,
  JudgeMatcherOptions,
  ToolPredicate,
  PredicateResult,
  AuthType,
  ProtocolEra,
  ProtocolRevision,
  ProtocolSetting,
  ProtocolProbeOptions,
  MCPProtocolInfo,
  ResultSource,
  GraderType,
  GraderScore,
  GraderBreakdown,
  GraderScoreMap,
  EvalCase,
  EvalDataset,
  EvalAssertions,
  JudgeExpectConfig,
  CaseJudge,
  CaseJudgeConfig,
  SerializedEvalDataset,
  LoadDatasetOptions,
  EvalCaseRequest,
  EvalContext,
  EvalCaseResult,
  EvalRunMetadata,
  TrialResult,
  EvalRunnerResult,
  EvalRunnerOptions,
  EvalCaseOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
  LLMProvider,
  LLMToolCall,
  MstClientSimulationResult,
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
  MCPConformanceOptions,
  MCPConformanceResult,
  MCPConformanceCheck,
  MCPConformanceRaw,
  MCPEvalReporterConfig,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  ClientDiagnostics,
} from './types/index.js';
export {
  MCPConfigSchema,
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
} from './config/mcpConfig.js';
export { PlaywrightOAuthClientProvider } from './auth/oauthClientProvider.js';
export {
  createTokenAuthHeaders,
  validateAccessToken,
  isTokenExpired,
  isTokenExpiringSoon,
} from './auth/tokenAuth.js';
export {
  performOAuthSetup,
  performOAuthSetupIfNeeded,
} from './auth/setupOAuth.js';
export { refreshAccessToken } from './auth/oauthFlow.js';
export { injectTokens } from './auth/storage.js';
export { CLIOAuthClient } from './auth/cli.js';
export {
  createMCPClientForConfig,
  closeMCPClient,
} from './mcp/clientFactory.js';
export {
  DEFAULT_PROTOCOL_SETTING,
  FIRST_MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  eraOfRevision,
  getProtocolInfo,
  isProtocolRevision,
} from './mcp/protocol.js';
export { protocolMatrix } from './config/protocolMatrix.js';
export type {
  ProtocolMatrixEntry,
  ProtocolMatrixProject,
} from './config/protocolMatrix.js';
export { normalizeToolResponse, extractText } from './mcp/response.js';
export { callToolNormalized, getToolProtocolError } from './mcp/callTool.js';
export type { ToolProtocolError } from './mcp/callTool.js';
export {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
  validateToolCalls,
  validateToolCallCount,
  validateJudge,
  validateSnapshot,
  playwrightSnapshotStore,
  validatePredicate,
  normalizeWhitespace,
} from './assertions/validators/index.js';
export { createMCPFixture } from './mcp/fixtures/mcpFixture.js';
export { test, expect } from './fixtures/mcp.js';
// The auth `test` is aliased to avoid colliding with the MCP `test` above. Use
// `mcpAuthTest` to extend auth fixtures (base.extend<MCPAuthFixtures>).
export { test as mcpAuthTest } from './fixtures/mcpAuth.js';
export {
  EvalCaseSchema,
  EvalDatasetSchema,
  validateEvalCase,
  validateEvalDataset,
} from './evals/datasetTypes.js';
export {
  loadEvalDataset,
  loadEvalDatasetFromObject,
} from './evals/datasetLoader.js';
// Types root APIs take or return: plugins and their judges, and the client
// trace in tool-call assertions and case results.
export type { Plugin, PluginMeta } from './plugins/plugin.js';
export type { PluginConfig } from './evals/evalConfig.js';
// For code that calls validators or matchers outside a runner or the fixture.
export { installPlugins } from './plugins/extensions.js';
export type {
  TraceEvent,
  TraceEvidence,
  Trace,
  JudgeDefinition,
  JudgeScore,
} from './evals/evalFrameworkTypes.js';
export { runEvalDataset, runEvalCase } from './evals/evalRunner.js';
export type {
  CaseExecution,
  ClientExecution,
  FailedExecution,
  ClientResponse,
} from './evals/caseExecution.js';
export type { ClientSkillsMode, SkillLoad } from './evals/mstClient/types.js';
export { createJudge } from './judge/judgeClient.js';
export {
  BUILT_IN_RUBRICS,
  resolveRubric,
  isBuiltInRubric,
} from './judge/judgeTypes.js';
export { runConformanceChecks } from './spec/conformanceChecks.js';
export { runCrossEraChecks } from './spec/crossEra.js';
export type {
  CrossEraOptions,
  CrossEraConnection,
  MCPCrossEraResult,
} from './spec/crossEra.js';
export type { ConformanceSeverity } from './types/reporter.js';
export type { SkillsCheckOptions } from './spec/checks/skills.js';
export { SKILLS_EXTENSION_ID, SkillEntrySchema } from './skills/skillsTypes.js';
export type {
  SkillEntry,
  SkillResourceEntry,
  SkillsExtensionSettings,
} from './skills/skillsTypes.js';
export {
  validateSkillEntry,
  parseSkillFrontmatter,
} from './skills/skillEntry.js';
export type { SkillEntryProblem } from './skills/skillEntry.js';
export {
  getSkillsExtension,
  listSkills,
  getSkill,
  readSkillFile,
  verifySkillFile,
} from './skills/skillsClient.js';
export type { SkillFileContent } from './skills/skillsClient.js';
export { createFixtureExtensions } from './mcp/fixtures/fixtureExtensions.js';
export type {
  MCPFixtureExtensions,
  MCPSkillsApi,
  MCPSkillFileRead,
} from './mcp/fixtures/fixtureExtensions.js';
