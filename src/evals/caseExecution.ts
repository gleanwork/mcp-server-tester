/**
 * Case execution: the one place an eval case runs.
 *
 * Every path (a direct tool call or MCP request, the simulated mcp_host, an
 * external host, or a suite host) produces a `CaseExecution`. The
 * runner reads its explicit fields and never inspects `response` to guess how
 * a case ran. Hosts and adapters produce traces; the runner owns every verdict.
 */
import { ProtocolError, type Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';
import { protocolErrorToToolResult } from '../mcp/callTool.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import {
  createMCPFixture,
  type MCPFixtureApi,
} from '../mcp/fixtures/mcpFixture.js';
import type { HostDiagnostics, UsageMetrics } from '../types/index.js';
import type { EvalCase } from './datasetTypes.js';
import type { EvalArm, EvalManifest, HostConfig } from './evalManifest.js';
import type {
  HostEvent,
  HostEvidence,
  HostRunResult,
} from './evalFrameworkTypes.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import type {
  ExternalHostMetadata,
  ExternalHostSimulationResult,
} from './externalHost/types.js';
import { getHost } from './builtinHosts.js';
import { hostTraceToExecution } from './hostTrace.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';

/** Accepts any JSON-RPC result object (validated later by expectations). */
const AnyResultSchema = z.looseObject({});

/** The host payload validators and reports read: the simulation shape. */
export type HostResponse = MCPHostSimulationResult & {
  events?: HostEvent[];
  evidence?: HostEvidence;
  externalHost?: ExternalHostMetadata;
};

interface ExecutionBase {
  /** Set when execution failed; expectations are not evaluated. */
  error?: string;
  /** Host time spent before the runner's timer started (batch traces). */
  preExecutionDurationMs?: number;
}

/** A direct tool call or MCP request. `response` is the raw result. */
export interface DirectExecution extends ExecutionBase {
  kind: 'direct';
  response: unknown;
}

/** An LLM or desktop host run, adapted to the simulation-shaped response. */
export interface HostExecution extends ExecutionBase {
  kind: 'host';
  response: HostResponse;
  /** Declared trace evidence. Undefined for the legacy simulated host. */
  evidence?: HostEvidence;
  usage?: UsageMetrics;
  telemetry?: Record<string, unknown>;
  diagnostics?: HostDiagnostics;
  externalHost?: ExternalHostMetadata;
}

/** Execution threw before producing a result. */
export interface FailedExecution extends ExecutionBase {
  kind: 'failed';
  response: undefined;
  error: string;
}

/** How one iteration of a case ran. */
export type CaseExecution = DirectExecution | HostExecution | FailedExecution;

const EXECUTION_KINDS = new Set<unknown>(['direct', 'host', 'failed']);

/**
 * Reject a custom executor's result that lacks a known `kind`. A pre-2.0
 * `{ response }` must fail loudly: read as direct, a host trace would silently
 * skip evidence gating and tool-name mapping.
 */
export function checkedExecution(value: unknown): CaseExecution {
  const kind =
    typeof value === 'object' && value !== null
      ? (value as { kind?: unknown }).kind
      : undefined;
  if (EXECUTION_KINDS.has(kind)) return value as CaseExecution;
  return failedExecution(
    new Error(
      "executeCase must return a CaseExecution with kind 'direct', 'host', or 'failed'. See the 2.0 migration guide."
    )
  );
}

function directExecution(response: unknown): DirectExecution {
  return { kind: 'direct', response };
}

export function failedExecution(error: unknown): FailedExecution {
  return {
    kind: 'failed',
    response: undefined,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Adapt a simulated (SDK/CLI/browser) or external host result. */
function simulationExecution(
  result: MCPHostSimulationResult | ExternalHostSimulationResult,
  error?: string
): HostExecution {
  return {
    kind: 'host',
    response: result,
    ...(error !== undefined ? { error } : {}),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...('externalHost' in result && result.externalHost
      ? { externalHost: result.externalHost }
      : {}),
  };
}

/**
 * Run a case against the fixture: a direct tool call or request, the simulated
 * mcp_host, or an external host. Failures become a `failed` execution.
 */
export async function executeEvalCase(
  evalCase: EvalCase,
  mcp: MCPFixtureApi | undefined
): Promise<CaseExecution> {
  const mode = evalCase.mode || 'direct';
  try {
    if (mode === 'mcp_host' || mode === 'host') {
      if (!mcp) throw new Error('This host requires an MCP connection.');
      if (!evalCase.scenario)
        throw new Error(
          `Eval case ${evalCase.id}: scenario is required for mcp_host mode`
        );
      if (!evalCase.mcpHostConfig)
        throw new Error(
          `Eval case ${evalCase.id}: mcpHostConfig is required for mcp_host mode`
        );
      const simulation = await simulateMCPHost(
        mcp,
        evalCase.scenario,
        evalCase.mcpHostConfig
      );
      if (simulation.success) return simulationExecution(simulation);
      const error = simulation.error || 'MCP host simulation failed';
      // Claude CLI startup failures keep their diagnostics in the response.
      if (evalCase.mcpHostConfig.cli?.claudeMcpServers !== undefined)
        return simulationExecution(simulation, error);
      throw new Error(error);
    }
    if (mode === 'external_host') {
      if (!evalCase.scenario)
        throw new Error(
          `Eval case ${evalCase.id}: scenario is required for external_host mode`
        );
      if (!evalCase.externalHost)
        throw new Error(
          `Eval case ${evalCase.id}: externalHost is required for external_host mode`
        );
      const result = await runExternalHostScenario(
        evalCase.scenario,
        evalCase.externalHost,
        { caseId: evalCase.id }
      );
      return simulationExecution(
        result,
        result.success
          ? undefined
          : result.error || 'External host simulation failed'
      );
    }
    if (evalCase.request) {
      if (evalCase.toolName)
        throw new Error(
          `Eval case ${evalCase.id}: request and toolName are mutually exclusive`
        );
      if (!mcp) throw new Error('Direct requests require an MCP connection.');
      try {
        return directExecution(
          await mcp.request(
            evalCase.request.method,
            evalCase.request.params,
            AnyResultSchema
          )
        );
      } catch (error) {
        // A JSON-RPC error is a result to assert on (expect.isError), exactly as
        // protocol errors from tools/call are.
        if (error instanceof ProtocolError)
          return directExecution(protocolErrorToToolResult(error));
        throw error;
      }
    }
    if (!evalCase.toolName)
      throw new Error(
        `Eval case ${evalCase.id}: toolName or request is required for direct mode`
      );
    if (!evalCase.args)
      throw new Error(
        `Eval case ${evalCase.id}: args is required for direct mode`
      );
    if (!mcp) throw new Error('Direct tool calls require an MCP connection.');
    return directExecution(
      await mcp.callTool(evalCase.toolName, evalCase.args)
    );
  } catch (error) {
    // Simulation errors are already enriched by the adapter; pass them through.
    return failedExecution(error);
  }
}

/** Everything a suite needs to run one case of one arm. */
export interface SuiteCaseExecutorOptions {
  servers: MCPConfig[];
  host: HostConfig;
  manifest: EvalManifest;
  arm?: EvalArm;
  env?: Record<string, string | undefined>;
  /** Traces from a batch host, consumed once per case iteration. */
  batchTraces?: Map<string, HostRunResult[]>;
  /** Called with each per-case direct connection, e.g. to record its protocol. */
  onDirectConnection?: (client: Client) => void;
}

/**
 * The suite's per-case executor for hosts with `run()` or `runBatch()`.
 * Direct cases open a short-lived connection to the selected server; host
 * cases consume a batch trace or call the host's `run()`.
 */
export function createSuiteCaseExecutor(
  options: SuiteCaseExecutorOptions
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const { servers, manifest, arm, env, batchTraces } = options;
  return async (evalCase) => {
    const declaration = evalCase.host ?? options.host;
    if ((evalCase.mode ?? 'direct') === 'direct') {
      const selected =
        servers.length === 1
          ? servers[0]
          : servers.find(
              (server) =>
                server.label &&
                (evalCase.request
                  ? evalCase.request.server === server.label
                  : evalCase.toolName?.startsWith(`${server.label}.`))
            );
      if (!selected)
        throw new Error(
          'Direct cases require one server, a label-qualified tool name, or request.server.'
        );
      if (
        evalCase.request?.server !== undefined &&
        evalCase.request.server !== selected.label
      )
        throw new Error(
          `request.server "${evalCase.request.server}" does not match the manifest's server${selected.label ? ` "${selected.label}"` : ''}.`
        );
      const client = await createMCPClientForConfig(selected);
      options.onDirectConnection?.(client);
      try {
        const toolName =
          selected.label && evalCase.toolName?.startsWith(`${selected.label}.`)
            ? evalCase.toolName.slice(selected.label.length + 1)
            : evalCase.toolName;
        return await executeEvalCase(
          { ...evalCase, toolName },
          createMCPFixture(client)
        );
      } finally {
        await closeMCPClient(client);
      }
    }
    const definition = getHost(declaration.type);
    if (batchTraces) {
      const trace = batchTraces.get(evalCase.id)?.shift();
      if (!trace)
        throw new Error(
          'Batch trace already consumed or missing; refusing to resubmit.'
        );
      return {
        ...hostTraceToExecution(trace, definition.evidence ?? 'none', servers),
        preExecutionDurationMs: trace.durationMs,
      };
    }
    if (!definition.run)
      throw new Error(
        `Host ${declaration.type} must expose run() for per-case dispatch.`
      );
    const trace = await definition.run(
      { scenario: evalCase.scenario ?? '', servers, env },
      declaration,
      { manifest, arm, env, mcpHostConfig: evalCase.mcpHostConfig }
    );
    return hostTraceToExecution(trace, definition.evidence ?? 'none', servers);
  };
}
