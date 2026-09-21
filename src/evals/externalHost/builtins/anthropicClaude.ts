import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseNdjson } from 'ndjson';
import type { LLMToolCall } from '../../mcpHost/mcpHostTypes.js';
import type {
  ExternalHostConfig,
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostFailureKind,
  ExternalHostMetadata,
  ExternalHostRunResult,
  HostArtifact,
  HostCapability,
  HostDriverId,
  HostRunContext,
} from '../types.js';
import type { UsageMetrics } from '../../../types/index.js';
import { driverToSlug, hostTypeFromDriver } from '../driverIdentity.js';
import {
  readMacosAccessibilityText,
  readMacosFrontWindowContents,
  runAppleScript,
} from './macosDesktop.js';

const DEFAULT_APP_NAME = 'Claude';
const POLL_INTERVAL_MS = 750;
const TRACE_SETTLE_AFTER_COMPLETE_MS = 1_500;
const CLAUDE_DESKTOP_MACOS_CAPABILITIES = [
  'control',
  'input',
  'completion',
  'trace',
  'normalize',
] as const;

export interface ClaudeSessionMetadata {
  sessionId?: string;
  cliSessionId?: string;
  createdAt?: string | number;
  lastActivityAt?: string | number;
  cwd?: string;
  model?: string;
  title?: string;
  initialMessage?: string;
}

export interface SessionCandidate {
  id: string;
  metadataPath: string;
  sessionDir: string;
  statMtimeMs: number;
  metadata: ClaudeSessionMetadata;
}

interface SnapshotEntry {
  mtimeMs: number;
}

export type ClaudeSessionSnapshot = Map<string, SnapshotEntry>;

export interface ClaudeNativeTelemetry {
  resultCount: number;
  /** Native logs do not establish an exact API request count. */
  apiCallCount?: number;
  /** Stable identities observed in native events, not exact API requests. */
  observedRequestCount?: number;
  observedAssistantMessageCount?: number;
  observationSource: 'claude-native-audit-and-transcript';
  models: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  toolCallCount: number;
  /** Observed tool_result errors; absent when no tool results were observed. */
  toolErrorCount?: number;
}

export interface ClaudeTrace {
  candidate: SessionCandidate;
  auditPath?: string;
  transcriptPath?: string;
  finalAnswer?: string;
  toolCalls: LLMToolCall[];
  usage?: UsageMetrics;
  requestId?: string;
  completedAt?: string;
  llmDurationMs?: number;
  terminalReason?: string;
  isError?: boolean;
  isComplete: boolean;
  auditParsed: boolean;
  transcriptParsed: boolean;
  usageAvailable: boolean;
  /** Fields explicitly present and valid in every native result, before defaults. */
  knownUsageFields: (keyof UsageMetrics)[];
  costAvailable: boolean;
  parseWarnings: string[];
  rawText: string;
  telemetry: ClaudeNativeTelemetry;
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeAuditEvent {
  type?: string;
  event?: ClaudeAuditEvent;
  index?: number;
  content_block?: ClaudeContentBlock;
  delta?: { type?: string; partial_json?: string };
  result?: unknown;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  model?: string;
  modelUsage?: Record<string, unknown>;
  requestId?: string;
  request_id?: string;
  usage?: Record<string, unknown>;
  message?: {
    id?: string;
    model?: string;
    content?: ClaudeContentBlock[] | string;
  };
  timestamp?: string;
  terminal_reason?: string;
}

export const ANTHROPIC_CLAUDE_CAPABILITIES: ExternalHostCapabilityImplementation[] =
  [
    {
      id: 'builtin:anthropic.claude.coworkSurface',
      capabilities: ['control'],
      run: rejectClaudeChatSurfaceCapability,
    },
    {
      id: 'builtin:anthropic.claude.activateCoworkSurface',
      capabilities: ['control'],
      run: activateCoworkSurfaceCapability,
    },
    {
      id: 'builtin:anthropic.claude.accessibilityTrace',
      capabilities: ['completion', 'trace', 'normalize'],
      run: captureClaudeChatAccessibilityResultCapability,
    },
    {
      id: 'builtin:anthropic.claude.localAgentTrace',
      capabilities: ['completion', 'trace'],
      setup: snapshotClaudeSessionsCapability,
      run: captureClaudeCoworkAgentTraceCapability,
    },
    {
      id: 'builtin:anthropic.claude.localAgentNormalize',
      capabilities: ['normalize'],
      run: normalizeClaudeCoworkAgentTraceCapability,
    },
  ];

/**
 * Deterministically switches the Claude desktop app to the Cowork surface via
 * Cmd+2 (the app's built-in shortcut for the Cowork sidebar tab). Idempotent —
 * sending Cmd+2 while already on Cowork is a no-op. Replaces the older
 * rejectClaudeChatSurface capability for use cases that need automatic surface
 * activation (e.g. CI runs).
 */
async function activateCoworkSurfaceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? DEFAULT_APP_NAME;
  const settleDelayMs = 700;
  const script = `
tell application ${JSON.stringify(appName)} to activate
delay 0.4
tell application "System Events"
  tell process ${JSON.stringify(appName)}
    set frontmost to true
    keystroke "2" using command down
  end tell
end tell
delay ${settleDelayMs / 1000}
return "ok"
`;
  try {
    await runAppleScript(script, { timeoutMs: 8_000 });
  } catch (err) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'submission_failed',
      error: `Failed to activate Cowork surface via Cmd+2: ${formatError(err)}`,
      artifacts: [],
      limitations: [
        'Cowork surface activation depends on Cmd+2 being bound to the Cowork sidebar tab in the user-installed Claude app version.',
      ],
    });
  }
}

async function rejectClaudeChatSurfaceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? DEFAULT_APP_NAME;
  const chatSurfaceReason = await detectClaudeChatSurface(appName);
  if (!chatSurfaceReason) {
    return;
  }

  return failureResult({
    config,
    context: run,
    driver: state.driver,
    displayName: state.displayName,
    capabilitiesUsed: state.capabilitiesUsed,
    failureKind: 'submission_failed',
    error: `${state.displayName} surface is not active: ${chatSurfaceReason}`,
    artifacts: [],
    limitations: [
      'Cowork is a distinct Claude Desktop surface; this driver will not submit Cowork evals through the regular Claude Chat composer.',
      'Open or focus an active Cowork/local-agent session before running this driver, or add a deterministic Cowork launch step.',
    ],
  });
}

async function snapshotClaudeSessionsCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const dataDir = getClaudeDataDir(config, binding);
  state.data.claudeDataDir = dataDir;

  try {
    state.data.claudeSessionSnapshot = await snapshotClaudeSessions(dataDir);
  } catch (err) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: `Failed to snapshot Claude session directory: ${formatError(err)}`,
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }
}

async function captureClaudeChatAccessibilityResultCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    return await waitForAccessibilityTrace({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      timeoutMs: run.timeoutMs,
      appName: runStringOption(config, binding, 'appName'),
    });
  } catch (err) {
    const message = formatError(err);
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: classifyTraceFailure(message),
      error: message,
      artifacts: [],
      limitations: [
        'Claude Chat Desktop currently uses Accessibility as the fallback trace source; IndexedDB parsing has not been stabilized.',
      ],
    });
  }
}

async function captureClaudeCoworkAgentTraceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const dataDir =
    typeof state.data.claudeDataDir === 'string'
      ? state.data.claudeDataDir
      : getClaudeDataDir(config, binding);
  const snapshot = state.data.claudeSessionSnapshot as
    | ClaudeSessionSnapshot
    | undefined;

  if (!snapshot) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: 'Claude Cowork trace step requires a session snapshot.',
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }

  try {
    state.data.claudeTrace = await waitForClaudeTrace({
      dataDir,
      marker: run.marker,
      correlation: run.correlation,
      snapshot,
      timeoutMs: run.timeoutMs,
      startedAtMs: run.startedAtMs,
    });
  } catch (err) {
    const message = formatError(err);
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: classifyTraceFailure(message),
      error: message,
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }
}

async function normalizeClaudeCoworkAgentTraceCapability({
  config,
  run,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult> {
  const trace = state.data.claudeTrace as ClaudeTrace | undefined;
  if (!trace) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: 'Claude Cowork trace normalization requires a parsed trace.',
      artifacts: [],
      limitations: [],
    });
  }

  const artifacts = buildArtifacts(trace);
  const metadata = buildClaudeTraceMetadata({
    config,
    context: run,
    driver: state.driver,
    displayName: state.displayName,
    capabilitiesUsed: state.capabilitiesUsed,
    artifacts,
    trace,
    limitations: trace.parseWarnings,
  });

  if (trace.isError) {
    return {
      success: false,
      toolCalls: trace.toolCalls,
      error:
        trace.finalAnswer ??
        `Claude host run failed${trace.terminalReason ? `: ${trace.terminalReason}` : ''}`,
      externalHost: {
        ...metadata,
        failureKind: 'host_run_failed',
      },
    };
  }

  if (trace.finalAnswer === undefined) {
    return {
      success: false,
      toolCalls: trace.toolCalls,
      error: 'Claude trace completed but did not include a final answer.',
      externalHost: {
        ...metadata,
        failureKind: 'parse_failure',
      },
    };
  }

  return {
    success: true,
    toolCalls: trace.toolCalls,
    response: trace.finalAnswer,
    conversationHistory: trace.finalAnswer
      ? [{ role: 'assistant', content: trace.finalAnswer }]
      : undefined,
    usage: trace.usage,
    llmDurationMs: trace.llmDurationMs,
    externalHost: metadata,
  };
}

function stringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}

function configStringOption(
  config: ExternalHostConfig,
  key: string
): string | undefined {
  const value = config.options?.[key];
  return typeof value === 'string' ? value : undefined;
}

function runStringOption(
  config: ExternalHostConfig,
  binding: { with?: Record<string, unknown> },
  key: string
): string | undefined {
  return stringOption(binding.with, key) ?? configStringOption(config, key);
}

export function getClaudeDataDir(
  config: ExternalHostConfig,
  binding?: { with?: Record<string, unknown> }
): string {
  const configuredDataDir = binding
    ? runStringOption(config, binding, 'dataDir')
    : configStringOption(config, 'dataDir');

  return (
    configuredDataDir ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions'
    )
  );
}

export async function snapshotClaudeSessions(
  dataDir: string
): Promise<ClaudeSessionSnapshot> {
  const snapshot = new Map<string, SnapshotEntry>();
  const sessions = await listSessionCandidates(dataDir);
  for (const session of sessions) {
    snapshot.set(session.metadataPath, { mtimeMs: session.statMtimeMs });
  }
  return snapshot;
}

interface ClaudeSessionMatchOptions {
  dataDir: string;
  marker?: string;
  correlation?: HostRunContext['correlation'];
  snapshot: ClaudeSessionSnapshot;
  startedAtMs: number;
  /** Fresh-session correlation: exact initial user text, never raw-text substring matching. */
  exactPrompt?: string;
  sessionPath?: string;
}

export async function waitForClaudeSession(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTrace> {
  return waitForClaudeMatch(options, false);
}

export async function waitForClaudeTrace(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTrace> {
  return waitForClaudeMatch(options, true);
}

async function waitForClaudeMatch(
  options: ClaudeSessionMatchOptions & { timeoutMs: number },
  requireCompletion: boolean
): Promise<ClaudeTrace> {
  const deadline = Date.now() + options.timeoutMs;
  let lastPending: ClaudeTrace | undefined;
  let completeTraceFirstSeenAtMs: number | undefined;

  while (Date.now() < deadline) {
    const matches = await findMatchingClaudeSessions(options);

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous Claude sessions for ${describeCorrelation(options)}: ${matches
          .map((m) => m.candidate.id)
          .join(', ')}`
      );
    }

    if (matches.length === 1) {
      const trace = matches[0]!;
      if (
        !requireCompletion ||
        isTraceReady(trace, completeTraceFirstSeenAtMs)
      ) {
        return trace;
      }
      if (trace.isComplete && completeTraceFirstSeenAtMs === undefined) {
        completeTraceFirstSeenAtMs = Date.now();
      }
      lastPending = trace;
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (lastPending) {
    throw new Error(
      `Timed out waiting for Claude session ${lastPending.candidate.id} to complete`
    );
  }

  throw new Error(
    `No matching Claude session found for ${describeCorrelation(options)}`
  );
}

function isTraceReady(
  trace: ClaudeTrace,
  completeTraceFirstSeenAtMs: number | undefined
): boolean {
  if (!trace.isComplete) {
    return false;
  }

  if (!trace.candidate.metadata.cliSessionId || trace.transcriptParsed) {
    return true;
  }

  return (
    completeTraceFirstSeenAtMs !== undefined &&
    Date.now() - completeTraceFirstSeenAtMs >= TRACE_SETTLE_AFTER_COMPLETE_MS
  );
}

export async function findMatchingClaudeSessions(
  options: ClaudeSessionMatchOptions
): Promise<ClaudeTrace[]> {
  const sessions = await listSessionCandidates(options.dataDir);
  const traces: ClaudeTrace[] = [];

  for (const session of sessions) {
    const previous = options.snapshot.get(session.metadataPath);
    const isNewOrUpdated =
      previous === undefined || session.statMtimeMs > previous.mtimeMs;
    const createdAtMs = metadataTimestampMs(session.metadata.createdAt);
    const isRecent =
      !Number.isNaN(createdAtMs) && createdAtMs >= options.startedAtMs - 5_000;

    if (options.sessionPath && session.metadataPath !== options.sessionPath)
      continue;
    if (options.exactPrompt !== undefined) {
      // Existing sessions remain excluded even if they change. The creation window
      // alone is never evidence of ownership. Do not match answers or tool output.
      if (
        previous !== undefined ||
        !isRecent ||
        createdAtMs > Date.now() + 5_000 ||
        session.metadata.initialMessage !== options.exactPrompt
      )
        continue;
      traces.push(await parseClaudeTrace(session));
      continue;
    }
    if (!isNewOrUpdated && !isRecent) {
      continue;
    }

    if (!options.marker && options.correlation?.includedInPrompt !== false)
      continue;
    const trace = await parseClaudeTrace(
      session,
      options.correlation?.includedInPrompt === false
        ? undefined
        : options.marker
    );
    if (
      sessionMatchesCorrelation({
        session,
        trace,
        marker: options.marker ?? '',
        correlation: options.correlation,
        isNewOrUpdated,
        isRecent,
      })
    ) {
      traces.push(trace);
    }
  }

  return traces;
}

function describeCorrelation(options: ClaudeSessionMatchOptions): string {
  if (options.exactPrompt !== undefined)
    return 'exact initial prompt in a new native session';
  if (options.correlation?.includedInPrompt) {
    return `marker ${options.marker}`;
  }
  return `${options.correlation?.strategy ?? 'none'} correlation near the run start`;
}

async function readAccessibilityFallback(
  config: ExternalHostConfig,
  context: HostRunContext,
  driver: HostDriverId,
  displayName: string,
  capabilitiesUsed: readonly HostCapability[],
  options: { appName?: string } = {}
): Promise<ExternalHostRunResult | undefined> {
  let visibleText: string;
  try {
    visibleText = await readMacosAccessibilityText(
      options.appName ??
        configStringOption(config, 'appName') ??
        DEFAULT_APP_NAME
    );
  } catch {
    return undefined;
  }

  if (!visibleText.includes(context.marker)) {
    return undefined;
  }

  const response = extractAccessibilityResponse(visibleText);
  if (!response) {
    return undefined;
  }

  return {
    success: true,
    toolCalls: [],
    response,
    conversationHistory: [{ role: 'assistant', content: response }],
    externalHost: {
      ...buildHostIdentityMetadata(config, driver, displayName),
      hostVariant: config.variant,
      capabilitiesUsed: [...capabilitiesUsed],
      traceSource: 'accessibility',
      traceConfidence: 'low',
      traceLimitations: [
        'Claude did not produce a matching local-agent transcript; final answer was captured from the visible Accessibility tree.',
        'Tool calls, token usage, cost, and hidden context are unavailable from this fallback source.',
      ],
      artifacts: [
        {
          kind: 'trace',
          name: 'Claude visible accessibility text',
          contentType: 'text/plain',
          summary: visibleText.slice(0, 1000),
        },
      ],
      session: {
        runMarker: context.marker,
      },
      correlation: context.correlation,
      sources: {
        finalAnswer: 'accessibility',
        toolCalls: 'none',
        usage: 'none',
        cost: 'none',
      },
      evidence: {
        finalAnswer: { source: 'accessibility', confidence: 'low' },
        toolCalls: { source: 'none', confidence: 'unknown' },
        usage: { source: 'none', confidence: 'unknown' },
        cost: { source: 'none', confidence: 'unknown' },
      },
    },
  };
}

async function detectClaudeChatSurface(
  appName: string
): Promise<string | undefined> {
  let surfaceText: string;
  try {
    // `entire contents of front window` is a single IPC batch transfer; it can
    // be multi-MB on a fully-loaded Electron window (handled by the maxBuffer
    // bump in runAppleScript). The recursive AppleScript alternative does one
    // IPC round-trip per element and hits the per-script timeout on large
    // trees.
    surfaceText = await readMacosFrontWindowContents(appName);
  } catch (err) {
    return `could not verify active Claude surface via Accessibility: ${formatError(err)}`;
  }

  if (looksLikeClaudeChatSurface(surfaceText)) {
    return 'visible controls match the regular Claude Chat surface';
  }

  return undefined;
}

export function looksLikeClaudeChatSurface(visibleText: string): boolean {
  const chatSignals = [
    'New chat',
    'Projects',
    'Artifacts',
    'Ask your org',
    'Write a message',
  ];
  const signalCount = chatSignals.filter((signal) =>
    visibleText.includes(signal)
  ).length;
  return signalCount >= 3;
}

async function waitForAccessibilityTrace(options: {
  config: ExternalHostConfig;
  context: HostRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed: readonly HostCapability[];
  timeoutMs: number;
  appName?: string;
}): Promise<ExternalHostRunResult> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const fallback = await readAccessibilityFallback(
      options.config,
      options.context,
      options.driver,
      options.displayName,
      options.capabilitiesUsed,
      { appName: options.appName }
    );
    if (fallback) {
      return fallback;
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for Claude Chat Desktop visible response for marker ${options.context.marker}`
  );
}

export async function parseClaudeTrace(
  candidate: SessionCandidate,
  marker?: string
): Promise<ClaudeTrace> {
  const parseWarnings: string[] = [];
  const auditPath = join(candidate.sessionDir, 'audit.jsonl');
  const transcriptPath = candidate.metadata.cliSessionId
    ? await findFile(
        candidate.sessionDir,
        `${candidate.metadata.cliSessionId}.jsonl`
      )
    : undefined;

  let auditEvents: ClaudeAuditEvent[] = [];
  let transcriptEvents: ClaudeAuditEvent[] = [];
  let rawAudit = '';
  let rawTranscript = '';
  let auditParsed = false;
  let transcriptParsed = false;

  try {
    rawAudit = await readFile(auditPath, 'utf-8');
    const parsed = await parseNdjsonContent<ClaudeAuditEvent>(
      rawAudit,
      'Claude audit log'
    );
    auditEvents = parsed.events;
    auditParsed = parsed.events.length > 0;
    parseWarnings.push(...parsed.warnings);
  } catch (err) {
    parseWarnings.push(`Could not read Claude audit log: ${formatError(err)}`);
  }

  if (transcriptPath) {
    try {
      rawTranscript = await readFile(transcriptPath, 'utf-8');
      const parsed = await parseNdjsonContent<ClaudeAuditEvent>(
        rawTranscript,
        'Claude transcript'
      );
      transcriptEvents = parsed.events;
      transcriptParsed = parsed.ok && parsed.events.length > 0;
      parseWarnings.push(...parsed.warnings);
    } catch (err) {
      parseWarnings.push(
        `Could not read Claude transcript: ${formatError(err)}`
      );
    }
  } else if (candidate.metadata.cliSessionId) {
    parseWarnings.push(
      `Could not locate transcript for cliSessionId ${candidate.metadata.cliSessionId}.`
    );
  }

  const auditEventsForRun = selectEventsForMarker(
    candidate.metadata,
    auditEvents,
    marker
  );
  const transcriptEventsForRun = selectEventsForMarker(
    candidate.metadata,
    transcriptEvents,
    marker
  );
  const combinedEventsForRun = [
    ...auditEventsForRun,
    ...transcriptEventsForRun,
  ];
  const resultEvents = dedupeResultEvents([
    ...auditEventsForRun.filter((event) => event.type === 'result'),
    ...transcriptEventsForRun.filter((event) => event.type === 'result'),
  ]);
  const resultEvent = resultEvents.at(-1);
  const finalAnswer =
    typeof resultEvent?.result === 'string'
      ? resultEvent.result
      : extractAssistantText(combinedEventsForRun);
  const usage = extractAggregatedUsage(resultEvents);
  const toolCalls = extractToolCalls(auditEventsForRun, transcriptEventsForRun);

  return {
    candidate,
    auditPath,
    transcriptPath,
    finalAnswer,
    toolCalls,
    usage,
    requestId: resultEvent?.requestId ?? resultEvent?.request_id,
    completedAt: resultEvent?.timestamp,
    llmDurationMs: resultEvent?.duration_api_ms ?? resultEvent?.duration_ms,
    terminalReason: resultEvent?.terminal_reason,
    isError: resultEvent?.is_error === true,
    isComplete: resultEvent !== undefined,
    auditParsed,
    transcriptParsed,
    usageAvailable: usage !== undefined,
    knownUsageFields: knownUsageFields(resultEvents),
    costAvailable: resultEvents.some(
      (event) => typeof event.total_cost_usd === 'number'
    ),
    parseWarnings,
    rawText: `${rawAudit}\n${rawTranscript}`,
    telemetry: buildNativeTelemetry(
      resultEvents,
      toolCalls,
      usage,
      combinedEventsForRun
    ),
  };
}

function selectEventsForMarker(
  metadata: ClaudeSessionMetadata,
  events: ClaudeAuditEvent[],
  marker?: string
): ClaudeAuditEvent[] {
  if (!marker) {
    return events;
  }

  const markerIndex = events.findIndex((event) =>
    JSON.stringify(event).includes(marker)
  );
  if (markerIndex < 0) {
    return metadata.initialMessage?.includes(marker) ? events : [];
  }

  const nextMarkerIndex = events.findIndex(
    (event, index) =>
      index > markerIndex &&
      /\[eval-run-marker:MCP_SERVER_TESTER_[A-Za-z0-9_-]+\]/u.test(
        JSON.stringify(event)
      )
  );
  return events.slice(
    markerIndex,
    nextMarkerIndex >= 0 ? nextMarkerIndex : undefined
  );
}

export function buildClaudeTraceMetadata(options: {
  config: ExternalHostConfig;
  context: HostRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed?: readonly HostCapability[];
  artifacts: HostArtifact[];
  trace: ClaudeTrace;
  limitations: string[];
}): ExternalHostMetadata {
  const correlationLimitations = options.context.correlation.includedInPrompt
    ? []
    : [
        'Trace was matched by recently updated host artifacts because no prompt marker was included.',
      ];
  const limitations = buildTraceLimitations(options.trace, [
    ...options.limitations,
    ...correlationLimitations,
  ]);
  const traceConfidence = getTraceConfidence(
    options.trace,
    options.context.correlation
  );
  const finalAnswerEvidence = buildEvidence(
    options.trace.isComplete && options.trace.finalAnswer !== undefined,
    traceConfidence
  );
  const toolCallsEvidence = buildEvidence(
    options.trace.transcriptParsed,
    traceConfidence
  );
  const usageEvidence = buildEvidence(
    options.trace.usageAvailable,
    traceConfidence
  );
  const costEvidence = buildEvidence(
    options.trace.costAvailable,
    traceConfidence
  );

  return {
    ...buildHostIdentityMetadata(
      options.config,
      options.driver,
      options.displayName
    ),
    hostVariant: options.config.variant,
    capabilitiesUsed: [
      ...(options.capabilitiesUsed ?? CLAUDE_DESKTOP_MACOS_CAPABILITIES),
    ],
    traceSource: 'host-local-transcript',
    traceConfidence,
    traceLimitations: limitations.length > 0 ? limitations : undefined,
    artifacts: options.artifacts,
    session: {
      id:
        options.trace.candidate.metadata.sessionId ??
        options.trace.candidate.id,
      runMarker: options.context.marker,
      requestId: options.trace.requestId,
      cliSessionId: options.trace.candidate.metadata.cliSessionId,
      cwd: options.trace.candidate.metadata.cwd,
      startedAt: metadataTimestampString(
        options.trace.candidate.metadata.createdAt
      ),
      completedAt: options.trace.completedAt,
    },
    correlation: options.context.correlation,
    sources: {
      finalAnswer: finalAnswerEvidence.source,
      toolCalls: toolCallsEvidence.source,
      usage: usageEvidence.source,
      cost: costEvidence.source,
    },
    evidence: {
      finalAnswer: finalAnswerEvidence,
      toolCalls: toolCallsEvidence,
      usage: usageEvidence,
      cost: costEvidence,
    },
  };
}

function buildEvidence(
  available: boolean,
  confidence: ExternalHostMetadata['traceConfidence']
) {
  return available
    ? ({ source: 'host-local-transcript', confidence } as const)
    : ({ source: 'none', confidence: 'unknown' } as const);
}

function getTraceConfidence(
  trace: ClaudeTrace,
  correlation: HostRunContext['correlation']
): ExternalHostMetadata['traceConfidence'] {
  if (!trace.isComplete || !trace.auditParsed) {
    return 'unknown';
  }
  if (
    trace.parseWarnings.some((warning) =>
      warning.startsWith('Claude audit log discarded')
    )
  ) {
    return 'medium';
  }
  return correlation.includedInPrompt ? 'high' : 'medium';
}

function buildTraceLimitations(
  trace: ClaudeTrace,
  limitations: string[]
): string[] {
  const output = [...limitations];

  if (!trace.transcriptParsed) {
    output.push(
      'Tool-call evidence is unavailable because a complete structured Claude transcript was not found or could not be parsed.'
    );
  }

  if (!trace.usageAvailable) {
    output.push('Usage evidence is unavailable from the parsed Claude trace.');
  }

  if (!trace.costAvailable) {
    output.push('Cost evidence is unavailable from the parsed Claude trace.');
  }

  return Array.from(new Set(output));
}

function failureResult(options: {
  config: ExternalHostConfig;
  context: HostRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed?: readonly HostCapability[];
  failureKind: ExternalHostFailureKind;
  error: string;
  artifacts: HostArtifact[];
  limitations: string[];
}): ExternalHostRunResult {
  return {
    success: false,
    toolCalls: [],
    error: options.error,
    externalHost: {
      ...buildHostIdentityMetadata(
        options.config,
        options.driver,
        options.displayName
      ),
      hostVariant: options.config.variant,
      capabilitiesUsed: [...(options.capabilitiesUsed ?? [])],
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: options.limitations,
      artifacts: options.artifacts,
      session: { runMarker: options.context.marker },
      correlation: options.context.correlation,
      failureKind: options.failureKind,
    },
  };
}

function buildHostIdentityMetadata(
  config: ExternalHostConfig,
  driver: HostDriverId,
  displayName: string
): Pick<
  ExternalHostMetadata,
  'driver' | 'driverSlug' | 'displayName' | 'hostName' | 'hostType'
> {
  return {
    driver,
    driverSlug: driverToSlug(driver),
    displayName,
    hostName: displayName,
    hostType: config.hostType ?? hostTypeFromDriver(driver),
  };
}

function buildArtifacts(trace: ClaudeTrace): HostArtifact[] {
  const artifacts: HostArtifact[] = [
    {
      kind: 'metadata',
      name: 'Claude session metadata',
      path: trace.candidate.metadataPath,
      contentType: 'application/json',
    },
  ];

  if (trace.auditPath) {
    artifacts.push({
      kind: 'audit',
      name: 'Claude audit log',
      path: trace.auditPath,
      contentType: 'application/x-ndjson',
    });
  }

  if (trace.transcriptPath) {
    artifacts.push({
      kind: 'transcript',
      name: 'Claude transcript',
      path: trace.transcriptPath,
      contentType: 'application/x-ndjson',
    });
  }

  return artifacts;
}

export function extractAccessibilityResponse(
  visibleText: string
): string | undefined {
  const lines = visibleText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const responseLine = [...lines]
    .reverse()
    .find((line) => line.startsWith('Claude responded: '));
  if (responseLine) {
    return responseLine.slice('Claude responded: '.length).trim();
  }

  const inlineResponseMatch = /Claude responded:\s*([^,\n]+)/.exec(visibleText);
  if (inlineResponseMatch?.[1]) {
    return inlineResponseMatch[1].trim();
  }

  const markerIndex = lines.findIndex((line) =>
    line.includes('[eval-run-marker:')
  );
  if (markerIndex >= 0) {
    return lines
      .slice(markerIndex + 1)
      .find(
        (line) =>
          !line.startsWith('Write a message') &&
          !line.includes('Claude is AI and can make mistakes')
      );
  }

  return undefined;
}

async function listSessionCandidates(
  dataDir: string
): Promise<SessionCandidate[]> {
  const metadataPaths = await findClaudeMetadataFiles(dataDir);
  const candidates: SessionCandidate[] = [];

  for (const metadataPath of metadataPaths) {
    try {
      const metadata = JSON.parse(
        await readFile(metadataPath, 'utf-8')
      ) as ClaudeSessionMetadata;
      const metadataStat = await stat(metadataPath);
      const id = basename(metadataPath, '.json');
      // Claude 2.110 stores files under <short UUID>/ and points cwd at
      // that directory's outputs folder. Retain the legacy local_<UUID>/ layout.
      const shortId = /^local_([a-f0-9]{8})-/i.exec(id)?.[1];
      const nativeDir = shortId
        ? join(dirname(metadataPath), shortId)
        : undefined;
      const sessionDir =
        nativeDir &&
        typeof metadata.cwd === 'string' &&
        isAbsolute(metadata.cwd) &&
        dirname(resolve(metadata.cwd)) === resolve(nativeDir)
          ? nativeDir
          : join(dirname(metadataPath), id);
      const statMtimeMs = await getSessionObservedMtime({
        sessionDir,
        cliSessionId: metadata.cliSessionId,
        metadataMtimeMs: metadataStat.mtimeMs,
      });
      candidates.push({
        id,
        metadataPath,
        sessionDir,
        statMtimeMs,
        metadata,
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

async function getSessionObservedMtime(options: {
  sessionDir: string;
  cliSessionId?: string;
  metadataMtimeMs: number;
}): Promise<number> {
  const observed = [
    options.metadataMtimeMs,
    await getFileMtime(join(options.sessionDir, 'audit.jsonl')),
    await getFileMtime(options.sessionDir),
  ];

  if (options.cliSessionId) {
    const transcriptPath = await findFile(
      options.sessionDir,
      `${options.cliSessionId}.jsonl`
    );
    if (transcriptPath) {
      observed.push(await getFileMtime(transcriptPath));
    }
  }

  return Math.max(
    ...observed.filter((mtime): mtime is number => mtime !== undefined)
  );
}

async function getFileMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function findClaudeMetadataFiles(root: string): Promise<string[]> {
  const stack = [root];
  const matches: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && /^local_.+\.json$/.test(entry.name)) {
        matches.push(path);
      } else if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }

  return matches;
}

function sessionMatchesMarker(
  session: SessionCandidate,
  trace: ClaudeTrace,
  marker: string
): boolean {
  if (session.metadata.initialMessage?.includes(marker)) {
    return true;
  }
  if (trace.finalAnswer?.includes(marker)) {
    return true;
  }
  return trace.rawText.includes(marker);
}

function sessionMatchesCorrelation(options: {
  session: SessionCandidate;
  trace: ClaudeTrace;
  marker: string;
  correlation?: HostRunContext['correlation'];
  isNewOrUpdated: boolean;
  isRecent: boolean;
}): boolean {
  if (options.correlation?.includedInPrompt !== false) {
    return sessionMatchesMarker(options.session, options.trace, options.marker);
  }

  return options.isNewOrUpdated || options.isRecent;
}

async function parseNdjsonContent<T>(
  content: string,
  sourceName: string
): Promise<{ events: T[]; ok: boolean; warnings: string[] }> {
  const events: T[] = [];
  const parser = parseNdjson({ strict: false });

  await new Promise<void>((resolve, reject) => {
    parser.on('data', (event: T) => events.push(event));
    parser.on('error', reject);
    parser.on('end', resolve);
    Readable.from([content]).pipe(parser);
  });

  const nonEmptyLineCount = content
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
  const discardedLineCount = nonEmptyLineCount - events.length;
  const warnings =
    discardedLineCount > 0
      ? [
          `${sourceName} discarded ${discardedLineCount} malformed JSONL line${
            discardedLineCount === 1 ? '' : 's'
          } using ndjson strict=false parsing.`,
        ]
      : [];

  return { events, ok: warnings.length === 0, warnings };
}

async function findFile(
  root: string,
  filename: string
): Promise<string | undefined> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return path;
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }

  return undefined;
}

function extractAssistantText(events: ClaudeAuditEvent[]): string | undefined {
  const parts: string[] = [];

  for (const event of events) {
    const blocks = Array.isArray(event.message?.content)
      ? event.message.content
      : [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      }
    }
  }

  return parts.length > 0 ? parts.join('') : undefined;
}

function nativeEvent(event: ClaudeAuditEvent): ClaudeAuditEvent {
  return event.type === 'stream_event' && event.event ? event.event : event;
}

function contentBlocks(event: ClaudeAuditEvent): ClaudeContentBlock[] {
  const native = nativeEvent(event);
  if (native.type === 'content_block_start' && native.content_block) {
    return [native.content_block];
  }
  return Array.isArray(native.message?.content) ? native.message.content : [];
}

function extractToolCalls(
  auditEvents: ClaudeAuditEvent[],
  transcriptEvents: ClaudeAuditEvent[]
): LLMToolCall[] {
  const events = [...auditEvents, ...transcriptEvents];
  const auditCalls: LLMToolCall[] = [];
  const transcriptCalls: LLMToolCall[] = [];
  const timestamps = new Map<LLMToolCall, number>();
  const byId = new Map<string, LLMToolCall>();
  const streams = new Map<number, { call: LLMToolCall; json: string }>();

  for (const [eventIndex, event] of events.entries()) {
    // Stream indexes are local to each source, not shared across files.
    if (eventIndex === auditEvents.length) streams.clear();
    const sourceCalls =
      eventIndex < auditEvents.length ? auditCalls : transcriptCalls;
    const native = nativeEvent(event);
    if (native.type === 'message_start') streams.clear();
    if (native.type === 'content_block_delta' && native.index !== undefined) {
      const stream = streams.get(native.index);
      if (stream && typeof native.delta?.partial_json === 'string') {
        stream.json += native.delta.partial_json;
        try {
          const input: unknown = JSON.parse(stream.json);
          if (input && typeof input === 'object' && !Array.isArray(input)) {
            stream.call.arguments = input as Record<string, unknown>;
          }
        } catch {
          // Partial streamed JSON is not yet an argument object.
        }
      }
    }
    for (const block of contentBlocks(event)) {
      if (block.type !== 'tool_use' || !block.name) continue;
      let call = block.id ? byId.get(block.id) : undefined;
      if (!call) {
        const mcpMatch = /^mcp__(.+)__(.+)$/.exec(block.name);
        call = {
          name: mcpMatch ? mcpMatch[2]! : block.name,
          rawName: block.name,
          source: mcpMatch ? 'mcp' : 'host',
          ...(mcpMatch ? { server: mcpMatch[1]! } : {}),
          arguments: block.input ?? {},
          id: block.id,
        };
        if (block.id) byId.set(block.id, call);
      } else if (block.input && Object.keys(block.input).length > 0) {
        // A completed block can enrich an earlier empty streaming start.
        call.arguments = block.input;
      }
      if (!sourceCalls.includes(call)) sourceCalls.push(call);
      const timestamp = metadataTimestampMs(
        event.timestamp ?? native.timestamp
      );
      if (Number.isFinite(timestamp) && !timestamps.has(call)) {
        timestamps.set(call, timestamp);
      }
      if (native.type === 'content_block_start' && native.index !== undefined) {
        streams.set(native.index, { call, json: '' });
      }
    }
  }

  // Results can precede calls when audit and transcript evidence are combined.
  for (const block of events.flatMap(contentBlocks)) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue;
    const call = byId.get(block.tool_use_id);
    if (!call) continue;
    if (Object.hasOwn(block, 'content')) {
      call.output =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
    }
    if (typeof block.is_error === 'boolean') {
      call.isError = block.is_error;
    }
  }
  return mergeToolCallOrder(auditCalls, transcriptCalls, timestamps);
}

function mergeToolCallOrder(
  auditCalls: LLMToolCall[],
  transcriptCalls: LLMToolCall[],
  timestamps: Map<LLMToolCall, number>
): LLMToolCall[] {
  // Never reorder transcript calls. Shared calls anchor audit-only evidence;
  // timestamps place it within those bounds when both sources supply them.
  const ordered = [...transcriptCalls];
  let cursor = 0;
  for (const [index, call] of auditCalls.entries()) {
    const sharedIndex = ordered.indexOf(call);
    if (sharedIndex >= 0) {
      cursor = Math.max(cursor, sharedIndex + 1);
      continue;
    }
    const nextAnchor = auditCalls
      .slice(index + 1)
      .find((next) => ordered.indexOf(next) >= cursor);
    const upperBound = nextAnchor
      ? ordered.indexOf(nextAnchor)
      : ordered.length;
    let insertionIndex = upperBound;
    const timestamp = timestamps.get(call);
    if (timestamp !== undefined) {
      for (let position = cursor; position < upperBound; position++) {
        const nextTimestamp = timestamps.get(ordered[position]!);
        if (nextTimestamp !== undefined && nextTimestamp > timestamp) {
          insertionIndex = position;
          break;
        }
      }
    }
    // Without time evidence, insert before the next shared call, or append.
    ordered.splice(insertionIndex, 0, call);
    cursor = insertionIndex + 1;
  }
  return ordered;
}

function dedupeResultEvents(events: ClaudeAuditEvent[]): ClaudeAuditEvent[] {
  const byRequest = new Map<string, ClaudeAuditEvent>();
  events.forEach((event) => {
    const key =
      event.requestId ??
      event.request_id ??
      JSON.stringify({
        timestamp: event.timestamp,
        result: event.result,
        usage: event.usage,
        cost: event.total_cost_usd,
        duration: event.duration_ms,
      });
    byRequest.set(key, event);
  });
  return [...byRequest.values()];
}

function extractAggregatedUsage(
  events: ClaudeAuditEvent[]
): UsageMetrics | undefined {
  const byRequest = new Map<string, UsageMetrics>();
  events.forEach((event, index) => {
    const usage = extractUsage(event);
    if (!usage) return;
    const requestId = event.requestId ?? event.request_id ?? `event-${index}`;
    const previous = byRequest.get(requestId);
    if (!previous) {
      byRequest.set(requestId, usage);
      return;
    }
    byRequest.set(requestId, {
      inputTokens: Math.max(previous.inputTokens, usage.inputTokens),
      outputTokens: Math.max(previous.outputTokens, usage.outputTokens),
      totalCostUsd:
        previous.totalCostUsd === undefined
          ? usage.totalCostUsd
          : usage.totalCostUsd === undefined
            ? previous.totalCostUsd
            : Math.max(previous.totalCostUsd, usage.totalCostUsd),
      durationMs: Math.max(previous.durationMs, usage.durationMs),
      durationApiMs:
        previous.durationApiMs === undefined &&
        usage.durationApiMs === undefined
          ? undefined
          : Math.max(previous.durationApiMs ?? 0, usage.durationApiMs ?? 0),
      cacheReadInputTokens: Math.max(
        previous.cacheReadInputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0
      ),
      cacheCreationInputTokens: Math.max(
        previous.cacheCreationInputTokens ?? 0,
        usage.cacheCreationInputTokens ?? 0
      ),
    });
  });

  const values = [...byRequest.values()];
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => ({
    inputTokens: total.inputTokens + value.inputTokens,
    outputTokens: total.outputTokens + value.outputTokens,
    totalCostUsd:
      total.totalCostUsd === undefined || value.totalCostUsd === undefined
        ? undefined
        : total.totalCostUsd + value.totalCostUsd,
    durationMs: total.durationMs + value.durationMs,
    durationApiMs:
      total.durationApiMs === undefined && value.durationApiMs === undefined
        ? undefined
        : (total.durationApiMs ?? 0) + (value.durationApiMs ?? 0),
    cacheReadInputTokens:
      (total.cacheReadInputTokens ?? 0) + (value.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (total.cacheCreationInputTokens ?? 0) +
      (value.cacheCreationInputTokens ?? 0),
  }));
}

function knownUsageFields(events: ClaudeAuditEvent[]): (keyof UsageMetrics)[] {
  const fields: [keyof UsageMetrics, (event: ClaudeAuditEvent) => unknown][] = [
    [
      'inputTokens',
      (event) => event.usage?.input_tokens ?? event.usage?.inputTokens,
    ],
    [
      'outputTokens',
      (event) => event.usage?.output_tokens ?? event.usage?.outputTokens,
    ],
    [
      'cacheReadInputTokens',
      (event) =>
        event.usage?.cache_read_input_tokens ??
        event.usage?.cacheReadInputTokens,
    ],
    [
      'cacheCreationInputTokens',
      (event) =>
        event.usage?.cache_creation_input_tokens ??
        event.usage?.cacheCreationInputTokens,
    ],
    ['totalCostUsd', (event) => event.total_cost_usd],
    ['durationMs', (event) => event.duration_ms],
    ['durationApiMs', (event) => event.duration_api_ms],
  ];
  return fields
    .filter(
      ([key, value]) =>
        events.length > 0 &&
        events.every((event) => {
          const number = value(event);
          return (
            typeof number === 'number' &&
            Number.isFinite(number) &&
            number >= 0 &&
            (key === 'totalCostUsd' || Number.isSafeInteger(number))
          );
        })
    )
    .map(([key]) => key);
}

function extractUsage(event: ClaudeAuditEvent): UsageMetrics | undefined {
  const usage = event.usage;
  const inputTokens =
    getNumber(usage, 'input_tokens') ?? getNumber(usage, 'inputTokens');
  const outputTokens =
    getNumber(usage, 'output_tokens') ?? getNumber(usage, 'outputTokens');

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    event.total_cost_usd === undefined &&
    event.duration_ms === undefined &&
    event.duration_api_ms === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalCostUsd: event.total_cost_usd ?? 0,
    durationMs: event.duration_ms ?? 0,
    durationApiMs: event.duration_api_ms,
    cacheReadInputTokens:
      getNumber(usage, 'cache_read_input_tokens') ??
      getNumber(usage, 'cacheReadInputTokens'),
    cacheCreationInputTokens:
      getNumber(usage, 'cache_creation_input_tokens') ??
      getNumber(usage, 'cacheCreationInputTokens'),
  };
}

function buildNativeTelemetry(
  resultEvents: ClaudeAuditEvent[],
  toolCalls: LLMToolCall[],
  usage: UsageMetrics | undefined,
  events: ClaudeAuditEvent[]
): ClaudeNativeTelemetry {
  const models = [
    ...new Set(
      events
        .filter(
          (event) => event.type === 'assistant' || event.type === 'result'
        )
        .flatMap((event) => [
          event.model,
          event.message?.model,
          ...Object.keys(event.modelUsage ?? {}),
        ])
        .filter(
          (model): model is string =>
            typeof model === 'string' && model.length > 0
        )
    ),
  ];
  const requestIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const event of events) {
    const native = nativeEvent(event);
    if (native.type !== 'assistant' && native.type !== 'message_start')
      continue;
    const requestId =
      native.requestId ??
      native.request_id ??
      event.requestId ??
      event.request_id;
    if (requestId) requestIds.add(requestId);
    if (native.message?.id) messageIds.add(native.message.id);
  }
  const toolResults = events
    .flatMap(contentBlocks)
    .filter((block) => block.type === 'tool_result');
  const errorIds = new Set(
    toolResults
      .filter((block) => block.is_error === true)
      .map((block) => block.tool_use_id ?? JSON.stringify(block))
  );
  return {
    resultCount: resultEvents.length,
    observationSource: 'claude-native-audit-and-transcript',
    ...(requestIds.size > 0 ? { observedRequestCount: requestIds.size } : {}),
    ...(messageIds.size > 0
      ? { observedAssistantMessageCount: messageIds.size }
      : {}),
    models,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadInputTokens: usage?.cacheReadInputTokens,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens,
    totalCostUsd: usage?.totalCostUsd,
    durationMs: usage?.durationMs,
    durationApiMs: usage?.durationApiMs,
    toolCallCount: toolCalls.length,
    ...(toolResults.length > 0 ? { toolErrorCount: errorIds.size } : {}),
  };
}

function getNumber(
  object: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = object?.[key];
  return typeof value === 'number' ? value : undefined;
}

function metadataTimestampMs(value: string | number | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

function metadataTimestampString(
  value: string | number | undefined
): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return undefined;
}

function classifyTraceFailure(message: string): ExternalHostFailureKind {
  const lower = message.toLowerCase();
  if (lower.includes('ambiguous')) return 'ambiguous_matching_sessions';
  if (lower.includes('timed out')) return 'timeout';
  if (lower.includes('no matching')) return 'no_matching_session';
  if (lower.includes('parse')) return 'parse_failure';
  return 'unknown';
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createExternalHostRunId(caseId: string): string {
  return `${caseId}-${randomUUID()}`;
}
