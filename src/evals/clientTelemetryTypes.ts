/**
 * What a desktop client (the ChatGPT app's `chatgpt` and `codex-app`)
 * records about a trial: evidence sources, artifacts, failure kinds and
 * native telemetry, on each result's `clientMetadata`. Exported from
 * `./experimental/clients`.
 */
import type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from './cowork/interaction.js';

/** Recorded by earlier versions only, from the driver identity. */
export type ExternalClientType = 'cli' | 'browser' | 'desktop' | 'custom';

/** Recorded by earlier versions only: the capability bindings a trial used. */
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

/**
 * Recorded by earlier versions only: the driver a trial ran through, such as
 * `openai.chatgpt.agent.desktop-app.macos`. The client, environment and OS
 * now say how a trial ran.
 */
export interface ClientDriverId {
  provider: string;
  product: string;
  surface: string;
  runtime: string;
  platform?: string;
  channel?: string;
}

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
  /** Recorded by earlier versions only; new results don't write it. */
  driver?: ClientDriverId;
  /** Recorded by earlier versions only; new results don't write it. */
  driverSlug?: string;
  /** Recorded by earlier versions only: the driver's name. */
  displayName?: string;
  /** Recorded by earlier versions only: the driver's name. */
  clientName?: string;
  /** Recorded by earlier versions only, from the driver identity. */
  clientType?: ExternalClientType;
  /** Recorded by earlier versions only. */
  clientVariant?: string;
  /** Recorded by earlier versions only; new results don't write it. */
  capabilitiesUsed?: ClientCapability[];
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

export interface EvidenceSource {
  source: TraceSource;
  confidence: ObservationConfidence;
}
