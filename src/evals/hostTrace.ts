import type { HostEvidence, HostRunResult } from './evalFrameworkTypes.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../types/index.js';

/** Internal runner execution envelope, also used for direct MCP calls. */
export interface EvalExecutionResult {
  response: unknown;
  error?: string;
  hostUsage?: UsageMetrics;
  hostTelemetry?: Record<string, unknown>;
  /** Host time already spent outside the current evaluation timer. */
  preExecutionDurationMs?: number;
  evidence?: HostEvidence;
}

/** Adapt once at the runner boundary, retaining original events for reporting. */
export function hostTraceToExecution(
  trace: HostRunResult,
  evidence: HostEvidence,
  servers: MCPConfig[] = []
): EvalExecutionResult {
  return {
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
    hostUsage: trace.usage,
    hostTelemetry: trace.telemetry,
    evidence,
  };
}

/** Compatibility shim for existing SDK/CLI simulators, not a second evaluator. */
export function simulationToHostTrace(
  result: MCPHostSimulationResult,
  servers: MCPConfig[]
): HostRunResult {
  return {
    finalText: result.response ?? '',
    error: result.success
      ? undefined
      : (result.error ?? 'Host execution failed.'),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    events: result.toolCalls.map((call) => {
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
        ...(call.durationMs !== undefined
          ? { durationMs: call.durationMs }
          : {}),
        ...(call.startedAt ? { startedAt: call.startedAt } : {}),
        ...(call.completedAt ? { completedAt: call.completedAt } : {}),
      };
    }),
  };
}
