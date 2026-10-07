import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseNdjson } from 'ndjson';
import type { LLMToolCall } from '../../mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../../../types/index.js';
import {
  splitClaudeMcpName,
  typeClaudeCodeCall,
} from '../../claudeCodeEvents.js';
import { formatError } from './claudeCommon.js';
import { findFile } from './claudeCommon.js';

// The session-store types live with the parser: parseClaudeTrace reads a
// SessionCandidate's files, and claudeSessions depends on this module.
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

interface ClaudeNativeTelemetry {
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
        const mcp = splitClaudeMcpName(block.name);
        call = {
          name: mcp ? mcp.name : block.name,
          rawName: block.name,
          source: mcp ? 'mcp' : 'host',
          ...(mcp ? { server: mcp.server } : {}),
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
  // Results are attached, so tool searches can read theirs.
  return mergeToolCallOrder(auditCalls, transcriptCalls, timestamps).map(
    typeClaudeCodeCall
  );
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
    totalCostUsd: event.total_cost_usd,
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

export function metadataTimestampMs(
  value: string | number | undefined
): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

/**
 * The bound native task's latest host tool call is an unanswered
 * AskUserQuestion: Claude is waiting for a person. A headless run cannot
 * answer, so the case fails now instead of waiting for the trace deadline.
 */
export function awaitingUserAnswer(trace: {
  isComplete: boolean;
  toolCalls: readonly { name: string; source?: string; output?: unknown }[];
}): boolean {
  if (trace.isComplete) return false;
  const last = trace.toolCalls.at(-1);
  return (
    last?.source === 'host' &&
    last.name === 'AskUserQuestion' &&
    last.output === undefined
  );
}
