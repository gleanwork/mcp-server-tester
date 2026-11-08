import type {
  TranscriptEvent,
  TranscriptEvidence,
  ClientRunResult,
  Transcript,
} from './evalFrameworkTypes.js';
import { withSkillEvents } from './mstClient/skills.js';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';
import type { LLMToolCall } from './mstClient/types.js';
import type { SkillLoad } from '../types/index.js';
import type { ClientExecution, ClientResponse } from './caseExecution.js';

/** Fill a missing server on one-server runs, without changing client names. */
function attributed(
  events: TranscriptEvent[],
  servers: MCPConfig[]
): TranscriptEvent[] {
  // 1.x and 2.0 beta clients marked built-in calls `source: 'host'`.
  if (events.some((event) => (event.source as string) === 'host'))
    throw new Error(
      "A client returned a transcript event with `source: 'host'`; it is now `source: 'builtin'` (the client's built-in tools)."
    );
  if (servers.length !== 1) return events;
  return events.map((event) =>
    event.source === 'mcp' && event.server === undefined
      ? { ...event, server: eventServer(event, servers) }
      : event
  );
}

/**
 * The server an MCP event's call went to: its own `server`, or on a
 * one-server run, that server's label.
 */
export function eventServer(
  event: TranscriptEvent,
  servers: readonly MCPConfig[]
): string | undefined {
  if (event.server !== undefined || servers.length !== 1) return event.server;
  return mcpServerLabel(servers[0]!, 0);
}

/** Only built-in fixtures qualify tool names with their server label. */
export function attributeBuiltinEvents(
  events: TranscriptEvent[],
  servers: MCPConfig[]
): TranscriptEvent[] {
  return attributed(
    events.map((event) => {
      if (event.source !== 'mcp' || event.server !== undefined) return event;
      const server = servers.find(
        (server) => server.label && event.name.startsWith(`${server.label}.`)
      );
      return server
        ? {
            ...event,
            name: event.name.slice(server.label!.length + 1),
            server: server.label,
          }
        : event;
    }),
    servers
  );
}

/** Adapt a client run once at the runner boundary, retaining original events for reporting. */
export function clientRunToExecution(
  run: ClientRunResult,
  evidence: TranscriptEvidence,
  servers: MCPConfig[] = []
): ClientExecution {
  const attributedRun = { ...run, events: attributed(run.events, servers) };
  const skillLoads = checkedSkillLoads(attributedRun.telemetry?.skillLoads);
  return {
    kind: 'completed',
    transcript: {
      events: attributedRun.events,
      ...timing(attributedRun),
      finalText: attributedRun.finalText,
      evidence,
      ...(attributedRun.usage ? { usage: attributedRun.usage } : {}),
      ...(attributedRun.error !== undefined
        ? { error: attributedRun.error }
        : {}),
    },
    response: {
      success: !attributedRun.error,
      response: attributedRun.finalText,
      events: attributedRun.events,
      evidence,
      toolCalls: attributedRun.events
        .filter((event) => event.kind === 'tool_call')
        .map((event) => ({
          name:
            event.server && servers.length > 1
              ? `${event.server}.${event.name}`
              : event.name,
          kind: event.kind,
          source: event.source,
          server: event.server,
          arguments: event.arguments ?? {},
          output: event.output,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.rawName !== undefined ? { rawName: event.rawName } : {}),
          id: event.id,
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(event.startedAt ? { startedAt: event.startedAt } : {}),
          ...(event.completedAt ? { completedAt: event.completedAt } : {}),
        })),
      usage: attributedRun.usage,
      ...(skillLoads !== undefined ? { skillLoads } : {}),
      ...(attributedRun.telemetry
        ? { telemetry: attributedRun.telemetry }
        : {}),
      ...(attributedRun.llmDurationMs !== undefined
        ? { llmDurationMs: attributedRun.llmDurationMs }
        : {}),
      ...(attributedRun.diagnostics
        ? { diagnostics: attributedRun.diagnostics }
        : {}),
      ...(attributedRun.artifacts
        ? { artifacts: attributedRun.artifacts }
        : {}),
    },
    error: attributedRun.error,
    ...(attributedRun.ending ? { ending: attributedRun.ending } : {}),
    usage: attributedRun.usage,
    telemetry: attributedRun.telemetry,
    ...(attributedRun.diagnostics
      ? { diagnostics: attributedRun.diagnostics }
      : {}),
    // A worker's record of its proxies' writes (withResultWriteRecord).
    ...(attributedRun.writeRecord
      ? { writeRecord: attributedRun.writeRecord }
      : {}),
    evidence,
  };
}

/** Keep the existing per-trial skill-load field only for well-formed records. */
function checkedSkillLoads(value: unknown): SkillLoad[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((load: unknown): load is SkillLoad => {
    if (typeof load !== 'object' || load === null) return false;
    const item = load as Record<string, unknown>;
    return (
      typeof item.name === 'string' &&
      typeof item.uri === 'string' &&
      typeof item.server === 'string' &&
      (item.kind === 'skill' || item.kind === 'file') &&
      (item.via === 'read_skill' ||
        item.via === 'read_resource' ||
        item.via === 'preload') &&
      (item.verified === null || typeof item.verified === 'boolean') &&
      typeof item.afterToolCalls === 'number' &&
      (item.problems === undefined ||
        (Array.isArray(item.problems) &&
          item.problems.every(
            (problem: unknown) => typeof problem === 'string'
          )))
    );
  })
    ? value
    : undefined;
}

/** A client run's model requests, task times and host telemetry, for its transcript. */
function timing(
  run: ClientRunResult
): Pick<
  Transcript,
  'modelCalls' | 'hostTelemetry' | 'startedAt' | 'completedAt'
> {
  return {
    ...(run.modelCalls?.length ? { modelCalls: run.modelCalls } : {}),
    ...(run.hostTelemetry ? { hostTelemetry: run.hostTelemetry } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  };
}

/** Attribute parser/SDK tool calls without converting a client result. */
export function toolCallEvents(
  calls: readonly LLMToolCall[],
  servers: MCPConfig[] = []
): TranscriptEvent[] {
  return calls.map((call) => {
    const server = servers.find(
      (server) => server.label && call.name.startsWith(`${server.label}.`)
    );
    const source =
      call.source ?? (server || servers.length === 1 ? 'mcp' : 'builtin');
    return {
      kind: call.kind ?? 'tool_call',
      source,
      name:
        server && call.source !== 'builtin'
          ? call.name.slice(server.label!.length + 1)
          : call.name,
      // Explicit parser provenance wins over the legacy server-count fallback.
      server:
        source === 'builtin'
          ? undefined
          : (call.server ??
            server?.label ??
            (servers.length === 1 ? servers[0]?.label : undefined)),
      arguments: call.arguments,
      output: call.output,
      ...(call.isError !== undefined ? { isError: call.isError } : {}),
      ...(call.rawName !== undefined ? { rawName: call.rawName } : {}),
      id: call.id,
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      ...(call.startedAt ? { startedAt: call.startedAt } : {}),
      ...(call.completedAt ? { completedAt: call.completedAt } : {}),
      ...(call.results !== undefined ? { results: call.results } : {}),
    };
  });
}

/** Only legacy custom executors need a transcript derived from their assertion view. */
export function responseTranscript(result: ClientResponse): Transcript {
  const events: TranscriptEvent[] = (result.toolCalls ?? []).map((call) => ({
    ...call,
    kind: call.kind ?? 'tool_call',
    source: call.source ?? 'mcp',
    arguments: call.arguments ?? {},
  }));
  return {
    // Explicit events retain native kinds, provenance and ordering.
    events: Array.isArray(result.events)
      ? result.events
      : result.skillLoads
        ? withSkillEvents(events, result.skillLoads)
        : events,
    ...(result.modelCalls?.length ? { modelCalls: result.modelCalls } : {}),
    ...(result.hostTelemetry ? { hostTelemetry: result.hostTelemetry } : {}),
    ...(result.response !== undefined ? { finalText: result.response } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.success === false
      ? { error: result.error ?? 'Client execution failed.' }
      : {}),
  };
}
