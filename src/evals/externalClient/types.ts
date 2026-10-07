import type {
  LLMToolCall,
  MstClientSimulationResult,
} from '../mstClient/types.js';
import type { UsageMetrics } from '../../types/index.js';
import type { CodexSetupConfig } from '../codexSetup/config.js';
import type {
  MarketplacePlugin,
  ClientPluginCredentials,
} from '../clientPlugins.js';
import type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from '../cowork/driver.js';

export type ExternalClientType = 'cli' | 'browser' | 'desktop' | 'custom';

export type ClientCapability =
  | 'control'
  | 'input'
  | 'completion'
  | 'trace'
  | 'normalize';

export type TraceSource =
  | 'mcp-proxy'
  | 'mcp-server-logs'
  | 'client-local-transcript'
  | 'client-native-export'
  | 'browser-api'
  | 'accessibility'
  | 'dom'
  | 'screenshot'
  | 'stdout'
  | 'manual-import'
  | 'none';

export type ObservationConfidence = 'high' | 'medium' | 'low' | 'unknown';

type ExternalClientCorrelationStrategy =
  | 'exact_prompt'
  | 'prompt_marker'
  | 'client_session_metadata'
  | 'none';

export interface ClientDriverId {
  provider: string;
  product: string;
  surface: string;
  runtime: string;
  platform?: string;
  channel?: string;
}

export type ClientDriverConfig = ClientDriverId | string;

export type ExternalClientFailureKind =
  | 'app_unavailable'
  | 'automation_permission_denied'
  | 'submission_failed'
  | 'no_matching_session'
  | 'ambiguous_matching_sessions'
  | 'timeout'
  | 'parse_failure'
  | 'client_run_failed'
  | 'cleanup_failed'
  | 'unsupported_client'
  | 'unknown';

export interface ClientArtifact {
  kind:
    | 'stdout'
    | 'stderr'
    | 'log'
    | 'transcript'
    | 'audit'
    | 'metadata'
    | 'screenshot'
    | 'video'
    | 'har'
    | 'trace';
  name: string;
  path?: string;
  contentType?: string;
  summary?: string;
}

export interface ExternalClientTelemetry {
  resultCount?: number;
  apiCallCount?: number;
  models?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  mcpToolCallCount?: number;
  mcpToolErrorCount?: number;
  builtinToolCallCount?: number;
  builtinToolErrorCount?: number;
  builtinToolDurationMs?: number;
  /** Wall-clock union of all native tool intervals, including built-in tools. */
  toolWallDurationMs?: number;
  /** Original native identities, independent of framework event source normalization. */
  toolProvenance?: Array<{
    id?: string;
    source: 'mcp' | 'builtin';
    nativeServer?: string;
    nativeTool: string;
    nativeItemType?: string;
    /** Native call has no recorded output yet. */
    pending?: boolean;
    /** Referenced inside a code-mode `exec` runner; no own arguments or timing. */
    viaCodeMode?: boolean;
  }>;
  /** The turn did not complete; calls and usage cover only what was recorded. */
  partial?: boolean;
  reasoningOutputTokens?: number;
  reasoningEffort?: string;
  timeToFirstTokenMs?: number;
  /** Wall-clock union of MCP call intervals; excludes overlap. */
  mcpWallDurationMs?: number;
}

export interface ExternalClientSession {
  id?: string;
  /** Absent when no marker was sent to the native client. */
  runMarker?: string;
  requestId?: string;
  turnId?: string;
  cliSessionId?: string;
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExternalClientCorrelationConfig {
  /**
   * How this run should be correlated with host-native evidence.
   *
   * - exact_prompt: match unchanged user text in a fresh native session.
   * - prompt_marker: append a marker to the submitted prompt.
   * - client_session_metadata: rely on host-native session metadata.
   * - none: no client-visible marker is submitted.
   */
  strategy?: ExternalClientCorrelationStrategy;
  /**
   * Whether the marker should be included in the client-visible prompt.
   * Defaults to true only for prompt_marker.
   */
  includeInPrompt?: boolean;
  /**
   * Optional prompt suffix template. Supports {{marker}}.
   */
  promptTemplate?: string;
}

export interface ExternalClientCorrelationMetadata {
  strategy: ExternalClientCorrelationStrategy;
  /** Internal run identifier; not sent to the client unless includedInPrompt is true. */
  marker: string;
  includedInPrompt: boolean;
  /** SHA-256 of the exact submitted UTF-8 prompt, where supported. */
  promptSha256?: string;
  promptUnchanged?: boolean;
  /** Native user text: literal match, or the app's single appended LF. */
  nativePromptMatch?:
    | 'exact'
    | 'native_terminal_lf'
    | 'native_markdown_escaped';
  nativePromptSha256?: string;
}

export interface ClientMetadata {
  driver: ClientDriverId;
  driverSlug: string;
  displayName: string;
  clientName: string;
  clientType: ExternalClientType;
  clientVariant?: string;
  capabilitiesUsed: ClientCapability[];
  traceSource: TraceSource;
  traceConfidence: ObservationConfidence;
  traceLimitations?: string[];
  artifacts: ClientArtifact[];
  session: ExternalClientSession;
  correlation: ExternalClientCorrelationMetadata;
  failureKind?: ExternalClientFailureKind;
  sources?: {
    finalAnswer?: TraceSource;
    toolCalls?: TraceSource;
    usage?: TraceSource;
    cost?: TraceSource;
  };
  telemetry?: ExternalClientTelemetry;
  /** Controller API accounting is separate from the evaluated application's usage. */
  computerUse?: {
    provider: 'anthropic-computer-use';
    submission: {
      status: 'completed' | 'failed';
      telemetry?: ComputerUseTelemetry;
    };
  };
  /** Deterministic native UI accounting; never reported as planner/model usage. */
  nativeController?: {
    provider: 'linux-atspi';
    surface: 'chatgpt-work' | 'codex';
    submission: {
      status: 'completed' | 'failed';
      telemetry?: SemanticDesktopTelemetry;
      /** Failure-only sanitized UI state: surface, counts, and text hash. Never text. */
      draftState?: Record<string, string | number | boolean>;
    };
  };
  evidence?: {
    finalAnswer?: EvidenceSource;
    toolCalls?: EvidenceSource;
    usage?: EvidenceSource;
    cost?: EvidenceSource;
  };
}

export interface ExternalClientConfig {
  /**
   * Canonical structured driver identity or derived slug.
   * Example: `anthropic.claude.cowork.desktop-app.macos`.
   */
  driver: ClientDriverConfig;
  /**
   * Human-readable client name shown in reports.
   */
  name?: string;
  /**
   * Client type shown in reports.
   */
  clientType?: ExternalClientType;
  /**
   * Optional variant label for matrix-style runs.
   */
  variant?: string;
  /**
   * End-to-end timeout for the client run.
   */
  timeoutMs?: number;
  /** Requested ChatGPT model ID (verified against the native turn record). */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /**
   * Capability bindings used to compose this external client runner.
   * If omitted, the runtime may provide a built-in default for known drivers.
   */
  capabilities?: ExternalClientCapabilitiesConfig;
  /**
   * Run correlation strategy. Built-in drivers may provide defaults.
   */
  correlation?: ExternalClientCorrelationConfig;
  /**
   * Optional managed MCP configuration lifecycle for the ChatGPT desktop driver.
   */
  codexSetup?: CodexSetupConfig;
  /**
   * Client plugins that MST installs into the fresh native profile before start.
   */
  plugins?: MarketplacePlugin[];
  /**
   * Resolved plugin MCP credentials (`<plugin>/<server>` -> token), from each
   * override's `auth.accessTokenEnv`. Never logged, receipted, or passed to the app.
   */
  pluginCredentials?: ClientPluginCredentials;
  /**
   * Driver-wide options available to capability implementations.
   */
  options?: Record<string, unknown>;
}

export interface ClientRunContext {
  runId: string;
  caseId: string;
  scenario: string;
  submittedScenario: string;
  marker: string;
  correlation: ExternalClientCorrelationMetadata;
  timeoutMs: number;
  startedAtMs: number;
}

export interface ExternalClientSimulationResult extends MstClientSimulationResult {
  clientMetadata: ClientMetadata;
}

interface ExternalClientRunSuccess {
  success: true;
  response?: string;
  toolCalls: LLMToolCall[];
  conversationHistory?: MstClientSimulationResult['conversationHistory'];
  usage?: UsageMetrics;
  llmDurationMs?: number;
  mcpDurationMs?: number;
  clientMetadata: ClientMetadata;
}

interface ExternalClientRunFailure {
  success: false;
  error: string;
  toolCalls: LLMToolCall[];
  /** Partial native evidence from a bound turn that did not complete. */
  conversationHistory?: MstClientSimulationResult['conversationHistory'];
  usage?: UsageMetrics;
  clientMetadata: ClientMetadata;
}

export type ExternalClientRunResult =
  | ExternalClientRunSuccess
  | ExternalClientRunFailure;

export type ExternalClientCapabilitiesConfig = Partial<
  Record<
    ClientCapability,
    ExternalClientCapabilityBinding | ExternalClientCapabilityBinding[]
  >
>;

export interface ExternalClientCapabilityBinding {
  /**
   * The built-in capability implementation, such as `builtin:platform.macos`.
   * Each driver's defaults (`builtinDrivers.ts`) name the ones it uses.
   */
  uses: string;
  /**
   * Binding-local options interpreted only by the selected implementation.
   */
  with?: Record<string, unknown>;
  /**
   * Extra capabilities this binding should satisfy beyond its map key.
   */
  provides?: ClientCapability[];
}

export interface ExternalClientRunState {
  driver: ClientDriverId;
  driverSlug: string;
  displayName: string;
  capabilitiesUsed: ClientCapability[];
  data: Record<string, unknown>;
  result?: ExternalClientRunResult;
}

export interface ExternalClientCapabilityContext {
  config: ExternalClientConfig;
  run: ClientRunContext;
  capability: ClientCapability;
  binding: ExternalClientCapabilityBinding;
  state: ExternalClientRunState;
}

/** A built-in capability implementation. Not a public extension point. */
export interface ExternalClientCapabilityImplementation {
  id: string;
  capabilities: ClientCapability[];
  setup?(
    context: ExternalClientCapabilityContext
  ): Promise<ExternalClientRunResult | void>;
  run?(
    context: ExternalClientCapabilityContext
  ): Promise<ExternalClientRunResult | void>;
  teardown?(context: ExternalClientCapabilityContext): Promise<void>;
}

export interface ExternalClientRunner {
  run(context: ClientRunContext): Promise<ExternalClientRunResult>;
}

export interface EvidenceSource {
  source: TraceSource;
  confidence: ObservationConfidence;
}
