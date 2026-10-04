import type {
  HostEvent,
  HostEvidence,
  HostRunResult,
  HostTrace,
} from './evalFrameworkTypes.js';
import { withSkillEvents } from './mcpHost/hostSkills.js';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import type { HostExecution } from './caseExecution.js';

/**
 * On a one-server arm, an MCP event that names no server came from that
 * server; give it the server's label so every call is attributable.
 */
function attributed(events: HostEvent[], servers: MCPConfig[]): HostEvent[] {
  if (servers.length !== 1) return events;
  const label = mcpServerLabel(servers[0]!, 0);
  return events.map((event) =>
    event.source === 'mcp' && event.server === undefined
      ? { ...event, server: label }
      : event
  );
}

/** Adapt a host run once at the runner boundary, retaining original events for reporting. */
export function hostRunToExecution(
  run: HostRunResult,
  evidence: HostEvidence,
  servers: MCPConfig[] = []
): HostExecution {
  const trace = { ...run, events: attributed(run.events, servers) };
  return {
    kind: 'host',
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
    },
    error: trace.error,
    usage: trace.usage,
    telemetry: trace.telemetry,
    ...(trace.diagnostics ? { diagnostics: trace.diagnostics } : {}),
    evidence,
  };
}

/** Compatibility shim for existing SDK/CLI simulators, not a second evaluator. */
export function simulationToHostRun(
  result: MCPHostSimulationResult,
  servers: MCPConfig[]
): HostRunResult {
  const toolEvents: HostEvent[] = result.toolCalls.map((call) => {
    const server = servers.find(
      (server) => server.label && call.name.startsWith(`${server.label}.`)
    );
    const source =
      call.source ?? (server || servers.length === 1 ? 'mcp' : 'host');
    return {
      kind: 'tool_call',
      source,
      name:
        server && call.source !== 'host'
          ? call.name.slice(server.label!.length + 1)
          : call.name,
      // Explicit parser provenance wins over the legacy server-count fallback.
      server:
        source === 'host'
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
    };
  });
  return {
    finalText: result.response ?? '',
    error: result.success
      ? undefined
      : (result.error ?? 'Host execution failed.'),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    // Skill loads by the simulated host become ordered `skill` events.
    events: result.skillLoads
      ? withSkillEvents(toolEvents, result.skillLoads)
      : toolEvents,
  };
}

/**
 * The trace of a simulated (SDK/CLI/browser) or external host result. Its
 * tool calls came through the MCP fixture unless they say otherwise.
 */
export function simulationTrace(result: MCPHostSimulationResult): HostTrace {
  // The simulated host only sees the fixture's tools; CLI parsers that also
  // see host tools mark those calls `source: 'host'`.
  const events: HostEvent[] = (result.toolCalls ?? []).map((call) => ({
    kind: 'tool_call',
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
  }));
  return {
    // A response that already carries host events (a suite host) keeps them.
    events: Array.isArray(result.events)
      ? result.events
      : result.skillLoads
        ? withSkillEvents(events, result.skillLoads)
        : events,
    ...(result.response !== undefined ? { finalText: result.response } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.success === false
      ? { error: result.error ?? 'Host execution failed.' }
      : {}),
  };
}
