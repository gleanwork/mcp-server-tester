import type {
  LLMToolCall,
  MCPHostSimulationResult,
} from '../mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../../types/index.js';
import type { CodexSetupConfig } from '../codexSetup/config.js';
import type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from '../cowork/driver.js';

export type ExternalHostType = 'cli' | 'browser' | 'desktop' | 'custom';

export type HostCapability =
  | 'control'
  | 'input'
  | 'completion'
  | 'trace'
  | 'normalize';

export type TraceSource =
  | 'mcp-proxy'
  | 'mcp-server-logs'
  | 'host-local-transcript'
  | 'host-native-export'
  | 'browser-api'
  | 'accessibility'
  | 'dom'
  | 'screenshot'
  | 'stdout'
  | 'manual-import'
  | 'none';

export type ObservationConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type ExternalHostCorrelationStrategy =
  | 'exact_prompt'
  | 'prompt_marker'
  | 'host_session_metadata'
  | 'none';

export interface HostDriverId {
  provider: string;
  product: string;
  surface: string;
  runtime: string;
  platform?: string;
  channel?: string;
}

export type HostDriverConfig = HostDriverId | string;

export type ExternalHostFailureKind =
  | 'app_unavailable'
  | 'automation_permission_denied'
  | 'submission_failed'
  | 'no_matching_session'
  | 'ambiguous_matching_sessions'
  | 'timeout'
  | 'parse_failure'
  | 'host_run_failed'
  | 'cleanup_failed'
  | 'unsupported_host'
  | 'unknown';

export interface HostArtifact {
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

export interface ExternalHostTelemetry {
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
  hostToolCallCount?: number;
  hostToolErrorCount?: number;
  hostToolDurationMs?: number;
  /** Wall-clock union of all native tool intervals, including built-in host tools. */
  toolWallDurationMs?: number;
  /** Original native identities, independent of framework event source normalization. */
  toolProvenance?: Array<{
    id?: string;
    source: 'mcp' | 'host';
    nativeServer?: string;
    nativeTool: string;
    nativeItemType?: string;
  }>;
  reasoningOutputTokens?: number;
  reasoningEffort?: string;
  timeToFirstTokenMs?: number;
  /** Wall-clock union of MCP call intervals; excludes overlap. */
  mcpWallDurationMs?: number;
}

export interface ExternalHostSession {
  id?: string;
  /** Absent when no marker was sent to the native host. */
  runMarker?: string;
  requestId?: string;
  turnId?: string;
  cliSessionId?: string;
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExternalHostCorrelationConfig {
  /**
   * How this run should be correlated with host-native evidence.
   *
   * - exact_prompt: match unchanged user text in a fresh native session.
   * - prompt_marker: append a marker to the submitted prompt.
   * - host_session_metadata: rely on host-native session metadata.
   * - none: no host-visible marker is submitted.
   */
  strategy?: ExternalHostCorrelationStrategy;
  /**
   * Whether the marker should be included in the host-visible prompt.
   * Defaults to true only for prompt_marker.
   */
  includeInPrompt?: boolean;
  /**
   * Optional prompt suffix template. Supports {{marker}}.
   */
  promptTemplate?: string;
}

export interface ExternalHostCorrelationMetadata {
  strategy: ExternalHostCorrelationStrategy;
  /** Internal run identifier; not sent to the host unless includedInPrompt is true. */
  marker: string;
  includedInPrompt: boolean;
  /** SHA-256 of the exact submitted UTF-8 prompt, where supported. */
  promptSha256?: string;
  promptUnchanged?: boolean;
  /** Native user text: literal match, or the app's single appended LF. */
  nativePromptMatch?: 'exact' | 'native_terminal_lf';
  nativePromptSha256?: string;
}

export interface ExternalHostMetadata {
  driver: HostDriverId;
  driverSlug: string;
  displayName: string;
  hostName: string;
  hostType: ExternalHostType;
  hostVariant?: string;
  capabilitiesUsed: HostCapability[];
  traceSource: TraceSource;
  traceConfidence: ObservationConfidence;
  traceLimitations?: string[];
  artifacts: HostArtifact[];
  session: ExternalHostSession;
  correlation: ExternalHostCorrelationMetadata;
  failureKind?: ExternalHostFailureKind;
  sources?: {
    finalAnswer?: TraceSource;
    toolCalls?: TraceSource;
    usage?: TraceSource;
    cost?: TraceSource;
  };
  telemetry?: ExternalHostTelemetry;
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
    };
  };
  evidence?: {
    finalAnswer?: EvidenceSource;
    toolCalls?: EvidenceSource;
    usage?: EvidenceSource;
    cost?: EvidenceSource;
  };
}

export interface ExternalHostConfig {
  /**
   * Canonical structured driver identity or derived slug.
   * Example: `anthropic.claude.cowork.desktop-app.macos`.
   */
  driver: HostDriverConfig;
  /**
   * Human-readable host name shown in reports.
   */
  name?: string;
  /**
   * Host type shown in reports.
   */
  hostType?: ExternalHostType;
  /**
   * Optional variant label for matrix-style runs.
   */
  variant?: string;
  /**
   * End-to-end timeout for the host run.
   */
  timeoutMs?: number;
  /** Requested ChatGPT model ID (verified against the native turn record). */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /**
   * Capability bindings used to compose this external host runner.
   * If omitted, the runtime may provide a built-in default for known drivers.
   */
  capabilities?: ExternalHostCapabilitiesConfig;
  /**
   * Run correlation strategy. Built-in drivers may provide defaults.
   */
  correlation?: ExternalHostCorrelationConfig;
  /**
   * Optional managed MCP configuration lifecycle for the ChatGPT desktop driver.
   */
  codexSetup?: CodexSetupConfig;
  /**
   * Driver-wide options available to capability implementations.
   */
  options?: Record<string, unknown>;
}

export interface HostRunContext {
  runId: string;
  caseId: string;
  scenario: string;
  submittedScenario: string;
  marker: string;
  correlation: ExternalHostCorrelationMetadata;
  timeoutMs: number;
  startedAtMs: number;
}

export interface ExternalHostSimulationResult extends MCPHostSimulationResult {
  externalHost: ExternalHostMetadata;
}

export interface ExternalHostRunSuccess {
  success: true;
  response?: string;
  toolCalls: LLMToolCall[];
  conversationHistory?: MCPHostSimulationResult['conversationHistory'];
  usage?: UsageMetrics;
  llmDurationMs?: number;
  mcpDurationMs?: number;
  externalHost: ExternalHostMetadata;
}

export interface ExternalHostRunFailure {
  success: false;
  error: string;
  toolCalls: LLMToolCall[];
  externalHost: ExternalHostMetadata;
}

export type ExternalHostRunResult =
  | ExternalHostRunSuccess
  | ExternalHostRunFailure;

export type ExternalHostCapabilitiesConfig = Partial<
  Record<
    HostCapability,
    ExternalHostCapabilityBinding | ExternalHostCapabilityBinding[]
  >
>;

export interface ExternalHostCapabilityBinding {
  /**
   * Implementation identifier. Built-ins use `builtin:<id>`; callers may use
   * `module:<specifier>#<export>` to load project-local integrations.
   */
  uses: string;
  /**
   * Binding-local options interpreted only by the selected implementation.
   */
  with?: Record<string, unknown>;
  /**
   * Extra capabilities this binding should satisfy beyond its map key.
   */
  provides?: HostCapability[];
}

export interface ExternalHostRunState {
  driver: HostDriverId;
  driverSlug: string;
  displayName: string;
  capabilitiesUsed: HostCapability[];
  data: Record<string, unknown>;
  result?: ExternalHostRunResult;
}

export interface ExternalHostCapabilityContext {
  config: ExternalHostConfig;
  run: HostRunContext;
  capability: HostCapability;
  binding: ExternalHostCapabilityBinding;
  state: ExternalHostRunState;
}

export interface ExternalHostCapabilityImplementation {
  id: string;
  capabilities: HostCapability[];
  setup?(
    context: ExternalHostCapabilityContext
  ): Promise<ExternalHostRunResult | void>;
  run?(
    context: ExternalHostCapabilityContext
  ): Promise<ExternalHostRunResult | void>;
  teardown?(context: ExternalHostCapabilityContext): Promise<void>;
}

export interface ExternalHostRunner {
  run(context: HostRunContext): Promise<ExternalHostRunResult>;
}

export interface EvidenceSource {
  source: TraceSource;
  confidence: ObservationConfidence;
}
