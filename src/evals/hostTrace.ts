import type { HostEvidence, HostRunResult } from './evalFrameworkTypes.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../types/index.js';

/** Internal runner execution envelope, also used for direct MCP calls. */
export interface EvalExecutionResult {
  response: unknown;
  error?: string;
  hostUsage?: UsageMetrics;
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
          arguments: event.arguments ?? {},
          output: event.output,
          id: event.id,
        })),
      usage: trace.usage,
    },
    error: trace.error,
    hostUsage: trace.usage,
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
    events: result.toolCalls.map((call) => {
      const server = servers.find(
        (server) => server.label && call.name.startsWith(`${server.label}.`)
      );
      return {
        kind: 'tool_call',
        source: server || servers.length === 1 ? 'mcp' : 'host',
        name: server ? call.name.slice(server.label!.length + 1) : call.name,
        // Preserve labels even for one server; matching may use unqualified names.
        server:
          server?.label ??
          (servers.length === 1 ? servers[0]?.label : undefined),
        arguments: call.arguments,
        output: call.output,
        id: call.id,
      };
    }),
  };
}
