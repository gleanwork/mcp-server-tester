/**
 * @gleanwork/mcp-server-tester
 *
 * Playwright-based testing framework for MCP servers
 *
 * @packageDocumentation
 */

// Types
export type {
  // Config
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPHostCapabilities,
  MCPAuthConfig,
  MCPOAuthConfig,
  MCPClientCredentialsConfig,

  // Auth
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

  // MCP
  CreateMCPClientOptions,
  ContentBlock,
  NormalizedToolResponse,
  MCPFixtureApi,
  MCPFixtureOptions,
  MCPAuthFixtures,

  // Assertions
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
  ToolCallExpectation,
  ToolCallCountOptions,
  JudgeValidatorConfig,
  JudgeMatcherOptions,
  ToolPredicate,
  PredicateResult,

  // Core
  AuthType,
  ResultSource,
  ExpectationType,
  EvalExpectationResult,
  ExpectationBreakdown,
  ExpectationResultMap,

  // Evals
  EvalCase,
  EvalDataset,
  EvalExpectBlock,
  JudgeExpectConfig,
  SerializedEvalDataset,
  EvalMode,
  LoadDatasetOptions,
  EvalCaseRequest,
  EvalContext,
  EvalCaseResult,
  EvalRunMetadata,
  IterationResult,
  EvalRunnerResult,
  EvalRunnerOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
  SaveBaselineOptions,
  ComparisonOutcome,
  CaseComparisonResult,
  ServerComparisonResult,
  ServerComparisonOptions,
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  HostType,
  CLIOutputFormat,
  CLIConfig,
  LLMProvider,
  MCPHostConfig,
  LLMToolCall,
  MCPHostSimulationResult,
  MCPHostSimulator,

  // Judge
  JudgeConfig,
  Judge,
  JudgeResult,
  UsageMetrics,
  ProviderKind,
  BuiltInRubric,
  RubricSpec,
  CustomJudgeExecutor,
  CustomJudgeResult,

  // Conformance
  MCPConformanceOptions,
  MCPConformanceResult,
  MCPConformanceCheck,
  MCPConformanceRaw,

  // Reporter
  MCPEvalReporterConfig,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPEvalData,
} from './types/index.js';
export { SnapshotSanitizers } from './types/index.js';

// Config
export {
  MCPConfigSchema,
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
} from './config/mcpConfig.js';

// Auth
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
export {
  performClientCredentialsFlow,
  refreshAccessToken,
} from './auth/oauthFlow.js';

// Discovery (RFC 9728)
export {
  discoverProtectedResource,
  discoverAuthorizationServer,
  DiscoveryError,
  MCP_PROTOCOL_VERSION,
} from './auth/discovery.js';

// Token Storage
export {
  loadTokens,
  hasValidTokens,
  injectTokens,
  loadTokensFromEnv,
  ENV_VAR_NAMES,
} from './auth/storage.js';

// CLI OAuth
export { CLIOAuthClient } from './auth/cli.js';

// MCP Client
export {
  createMCPClientForConfig,
  closeMCPClient,
} from './mcp/clientFactory.js';

// Response Normalization
export { normalizeToolResponse, extractText } from './mcp/response.js';

// Assertions - Matchers (primary API)
// The extended expect with MCP tool matchers is exported via fixtures
// Use: import { expect } from '@gleanwork/mcp-server-tester'

// Assertions - Validators (for programmatic use)
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
  getResponseSizeBytes,
  normalizeWhitespace,
} from './assertions/validators/index.js';

// Fixtures
export { createMCPFixture } from './mcp/fixtures/mcpFixture.js';
export { test, expect } from './fixtures/mcp.js';

// Auth fixtures — re-exported from main path for convenience.
// The auth `test` is aliased to avoid a name collision with the MCP `test` above.
// Use `mcpAuthTest` when you need to extend auth fixtures (e.g., base.extend<MCPAuthFixtures>).
export { test as mcpAuthTest } from './fixtures/mcpAuth.js';

// Eval Dataset
export {
  EvalCaseSchema,
  EvalDatasetSchema,
  validateEvalCase,
  validateEvalDataset,
} from './evals/datasetTypes.js';

// Eval Loader
export {
  loadEvalDataset,
  loadEvalDatasetFromObject,
} from './evals/datasetLoader.js';

// Eval Runner
export { runEvalDataset, runEvalCase } from './evals/evalRunner.js';

// Baseline eval comparison
export { saveBaseline, loadBaseline } from './evals/baseline.js';

// Multi-server A/B comparison
export { runServerComparison } from './evals/serverComparison.js';

// Completed eval run comparison
export { compareEvalRuns } from './evals/evalRunComparison.js';

// MCP Host Simulation
export {
  simulateMCPHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from './evals/mcpHost/index.js';

// Judge
export { createJudge } from './judge/judgeClient.js';
export {
  BUILT_IN_RUBRICS,
  resolveRubric,
  isBuiltInRubric,
} from './judge/judgeTypes.js';

// Custom Judge Registry
export {
  registerJudge,
  getRegisteredJudge,
  clearJudgeRegistry,
} from './judge/judgeRegistry.js';

// Conformance
export { runConformanceChecks } from './spec/conformanceChecks.js';
