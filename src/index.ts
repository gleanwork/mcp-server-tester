/**
 * @gleanwork/mcp-server-tester
 *
 * Playwright-based testing framework for MCP servers
 *
 * @packageDocumentation
 */

// Config
export type {
  MCPConfig,
  StdioMCPConfig,
  HttpMCPConfig,
  MCPHostCapabilities,
  MCPAuthConfig,
  MCPOAuthConfig,
  MCPClientCredentialsConfig,
} from './config/mcpConfig.js';
export {
  MCPConfigSchema,
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
} from './config/mcpConfig.js';

// Auth
export type {
  StoredTokens,
  StoredClientInfo,
  StoredOAuthState,
  OAuthSetupConfig,
  TokenResult,
} from './auth/types.js';
export {
  PlaywrightOAuthClientProvider,
  type PlaywrightOAuthClientProviderConfig,
} from './auth/oauthClientProvider.js';
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
  type ClientCredentialsConfig,
} from './auth/oauthFlow.js';

// Discovery (RFC 9728)
export {
  discoverProtectedResource,
  discoverAuthorizationServer,
  DiscoveryError,
  MCP_PROTOCOL_VERSION,
  type ProtectedResourceMetadata,
  type ProtectedResourceDiscoveryResult,
} from './auth/discovery.js';

// Token Storage
export {
  loadTokens,
  hasValidTokens,
  injectTokens,
  loadTokensFromEnv,
  ENV_VAR_NAMES,
  type StoredServerMetadata,
} from './auth/storage.js';

// CLI OAuth
export {
  CLIOAuthClient,
  type CLIOAuthClientConfig,
  type CLIOAuthResult,
} from './auth/cli.js';

// MCP Client
export {
  createMCPClientForConfig,
  closeMCPClient,
  type CreateMCPClientOptions,
} from './mcp/clientFactory.js';

// Response Normalization
export type { ContentBlock, NormalizedToolResponse } from './mcp/response.js';
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

export { SnapshotSanitizers } from './assertions/validators/types.js';
export type {
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
} from './assertions/validators/types.js';

export type {
  ToolCallExpectation,
  ToolCallCountOptions,
} from './assertions/validators/toolCalls.js';

export type { JudgeValidatorConfig } from './assertions/validators/judge.js';

export type {
  JudgeMatcherOptions,
  ToolPredicate,
  PredicateResult,
} from './assertions/matchers/types.js';

// Fixtures
export type {
  MCPFixtureApi,
  MCPFixtureOptions,
  AuthType,
} from './mcp/fixtures/mcpFixture.js';
export { createMCPFixture } from './mcp/fixtures/mcpFixture.js';
export { test, expect } from './fixtures/mcp.js';

// Auth fixtures — re-exported from main path for convenience.
// The auth `test` is aliased to avoid a name collision with the MCP `test` above.
// Use `mcpAuthTest` when you need to extend auth fixtures (e.g., base.extend<MCPAuthFixtures>).
export type { MCPAuthFixtures } from './fixtures/mcpAuth.js';
export { test as mcpAuthTest } from './fixtures/mcpAuth.js';

// Canonical Types (single source of truth)
export type {
  ResultSource,
  ExpectationType,
  ExpectationBreakdown,
  ExpectationResultMap,
} from './types/index.js';

// Eval Dataset
export type {
  EvalCase,
  EvalDataset,
  EvalExpectBlock,
  SerializedEvalDataset,
  EvalMode,
} from './evals/datasetTypes.js';
export {
  EvalCaseSchema,
  EvalDatasetSchema,
  validateEvalCase,
  validateEvalDataset,
} from './evals/datasetTypes.js';

// Eval Loader
export type { LoadDatasetOptions } from './evals/datasetLoader.js';
export {
  loadEvalDataset,
  loadEvalDatasetFromObject,
} from './evals/datasetLoader.js';

// Eval Runner
export type {
  EvalContext,
  EvalExpectationResult,
  EvalCaseResult,
  IterationResult,
  EvalRunnerResult,
  EvalRunnerOptions,
} from './evals/evalRunner.js';
export { runEvalDataset, runEvalCase } from './evals/evalRunner.js';

// Baseline eval comparison
export { saveBaseline, loadBaseline } from './evals/baseline.js';

// Multi-server A/B comparison
export type {
  ComparisonOutcome,
  CaseComparisonResult,
  ServerComparisonResult,
  ServerComparisonOptions,
} from './evals/serverComparison.js';
export { runServerComparison } from './evals/serverComparison.js';

// LLM Host Simulation
export type {
  LLMProvider,
  LLMHostConfig,
  LLMToolCall,
  LLMHostSimulationResult,
  LLMHostSimulator,
} from './evals/llmHost/index.js';
export {
  simulateLLMHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from './evals/llmHost/index.js';

// Judge
export type {
  JudgeConfig,
  Judge,
  JudgeResult,
  UsageMetrics,
  ProviderKind,
  BuiltInRubric,
  RubricSpec,
} from './judge/judgeTypes.js';
export { createJudge } from './judge/judgeClient.js';
export {
  BUILT_IN_RUBRICS,
  resolveRubric,
  isBuiltInRubric,
} from './judge/judgeTypes.js';

// Conformance
export type {
  MCPConformanceOptions,
  MCPConformanceResult,
  MCPConformanceCheck,
  MCPConformanceRaw,
} from './spec/conformanceChecks.js';
export { runConformanceChecks } from './spec/conformanceChecks.js';

// Reporter types — primarily used by the mcpReporter plugin.
// These types are available for custom reporter implementations or
// when consuming reporter output programmatically.
// Import the reporter itself from '@gleanwork/mcp-server-tester/reporters/mcpReporter'
export type {
  MCPEvalReporterConfig,
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPEvalData,
} from './reporters/types.js';
