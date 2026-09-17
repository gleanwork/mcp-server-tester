import type {
  LLMToolCall,
  MCPHostSimulationResult,
} from '../mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../../types/index.js';

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

export interface ExternalHostSession {
  id?: string;
  runMarker: string;
  requestId?: string;
  cliSessionId?: string;
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExternalHostCorrelationConfig {
  /**
   * How this run should be correlated with host-native evidence.
   *
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
  marker: string;
  includedInPrompt: boolean;
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
}

export interface ExternalHostRunner {
  run(context: HostRunContext): Promise<ExternalHostRunResult>;
}

export interface EvidenceSource {
  source: TraceSource;
  confidence: ObservationConfidence;
}
