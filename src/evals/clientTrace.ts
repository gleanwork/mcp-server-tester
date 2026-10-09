import type {
  TraceEvent,
  TraceEvidence,
  ClientRunResult,
  Trace,
} from './evalFrameworkTypes.js';
import { withSkillEvents } from './mstClient/skills.js';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';
import type { MstClientSimulationResult } from './mstClient/types.js';
import type { ClientExecution } from './caseExecution.js';

/**
 * On a one-server variant, an MCP event that names no server came from that
 * server; give it the server's label so every call is attributable.
 */
function attributed(events: TraceEvent[], servers: MCPConfig[]): TraceEvent[] {
  // 1.x and 2.0 beta clients marked built-in calls `source: 'host'`.
  if (events.some((event) => (event.source as string) === 'host'))
    throw new Error(
      "A client returned a trace event with `source: 'host'`; it is now `source: 'builtin'` (the client's built-in tools)."
    );
  if (servers.length !== 1) return events;
  const label = mcpServerLabel(servers[0]!, 0);
  return events.map((event) =>
    event.source === 'mcp' && event.server === undefined
      ? { ...event, server: label }
      : event
  );
}

/** Adapt a client run once at the runner boundary, retaining original events for reporting. */
export function clientRunToExecution(
  run: ClientRunResult,
  evidence: TraceEvidence,
  servers: MCPConfig[] = []
): ClientExecution {
  const trace = { ...run, events: attributed(run.events, servers) };
  return {
    kind: 'completed',
    trace: {
      events: trace.events,
      finalText: trace.finalText,
      evidence,
      ...(trace.usage ? { usage: trace.usage } : {}),
      ...(trace.error !== undefined ? { error: trace.error } : {}),
    },
    response: {
      success: !trace.error,
      response: trace.finalText,
      events: trace.events,
      evidence,
      toolCalls: trace.events
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
      usage: trace.usage,
      ...(trace.telemetry ? { telemetry: trace.telemetry } : {}),
      ...(trace.llmDurationMs !== undefined
        ? { llmDurationMs: trace.llmDurationMs }
        : {}),
      ...(trace.diagnostics ? { diagnostics: trace.diagnostics } : {}),
      ...(trace.artifacts ? { artifacts: trace.artifacts } : {}),
    },
    error: trace.error,
    usage: trace.usage,
    telemetry: trace.telemetry,
    ...(trace.diagnostics ? { diagnostics: trace.diagnostics } : {}),
    evidence,
  };
}

/** Compatibility shim for existing SDK/CLI simulators, not a second evaluator. */
export function simulationToClientRun(
  result: MstClientSimulationResult,
  servers: MCPConfig[]
): ClientRunResult {
  const toolEvents: TraceEvent[] = result.toolCalls.map((call) => {
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
  return {
    finalText: result.response ?? '',
    error: result.success
      ? undefined
      : (result.error ?? 'Client execution failed.'),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    // Skill loads by the simulated client become ordered `skill` events.
    events: result.skillLoads
      ? withSkillEvents(toolEvents, result.skillLoads)
      : toolEvents,
  };
}

/**
 * The trace of a simulated (SDK/CLI/browser) or external client result. Its
 * tool calls came through the MCP fixture unless they say otherwise.
 */
export function simulationTrace(result: MstClientSimulationResult): Trace {
  // The simulated client only sees the fixture's tools; CLI parsers that also
  // see built-in tools mark those calls `source: 'builtin'`.
  const events: TraceEvent[] = (result.toolCalls ?? []).map((call) => ({
    kind: call.kind ?? 'tool_call',
    source: call.source ?? 'mcp',
    name: call.name,
    ...(call.server !== undefined ? { server: call.server } : {}),
    arguments: call.arguments ?? {},
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.isError !== undefined ? { isError: call.isError } : {}),
    ...(call.rawName !== undefined ? { rawName: call.rawName } : {}),
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.startedAt ? { startedAt: call.startedAt } : {}),
    ...(call.completedAt ? { completedAt: call.completedAt } : {}),
    ...(call.results !== undefined ? { results: call.results } : {}),
  }));
  return {
    // A response that already carries client events (an eval client) keeps them.
    events: Array.isArray(result.events)
      ? result.events
      : result.skillLoads
        ? withSkillEvents(events, result.skillLoads)
        : events,
    ...(result.response !== undefined ? { finalText: result.response } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.success === false
      ? { error: result.error ?? 'Client execution failed.' }
      : {}),
  };
}
