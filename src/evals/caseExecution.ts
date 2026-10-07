/**
 * Case execution: the one place an eval case runs.
 *
 * Every path (a direct tool call or MCP request, the mst client on the
 * test's connection, or a suite's client) produces a `CaseExecution`. The
 * runner reads its explicit fields and never inspects `response` to guess how
 * a case ran. Hosts and adapters produce traces; the runner owns every verdict.
 */
import { randomUUID } from 'node:crypto';
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
import type { ClientDiagnostics, UsageMetrics } from '../types/index.js';
import { isClientCase, type EvalCase } from './datasetTypes.js';
import type { EvalArm, EvalManifest, ClientConfig } from './evalManifest.js';
import { clientPatchOf, type ClientFields } from './clientFields.js';
import type {
  TraceEvent,
  TraceEvidence,
  ClientRunResult,
  Trace,
} from './evalFrameworkTypes.js';
import type {
  ExternalHostMetadata,
  ExternalHostSimulationResult,
} from './externalHost/types.js';
import { getBuiltinHostConfig, getHost } from './builtinHosts.js';
import { hostRunToExecution, simulationTrace } from './hostTrace.js';
import { withOriginalToolNames } from './toolSurface.js';
import {
  settleProxiedTrace,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';

/** Accepts any JSON-RPC result object (validated later by expectations). */
const AnyResultSchema = z.looseObject({});

/** The host payload validators and reports read: the simulation shape. */
export type ClientResponse = MCPHostSimulationResult & {
  events?: TraceEvent[];
  evidence?: TraceEvidence;
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
  response: ClientResponse;
  /**
   * What the host did, as it reported it. A custom executor may omit it;
   * the runner then derives it from `response`.
   */
  trace?: Trace;
  /** Declared trace evidence. Undefined for the legacy simulated host. */
  evidence?: TraceEvidence;
  usage?: UsageMetrics;
  telemetry?: Record<string, unknown>;
  diagnostics?: ClientDiagnostics;
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
    trace: simulationTrace(result),
    ...(error !== undefined ? { error } : {}),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...('externalHost' in result && result.externalHost
      ? { externalHost: result.externalHost }
      : {}),
  };
}

/**
 * The client a case runs on outside a suite: its own `client`, `model` and
 * `clientOptions` over the run's. Only `mst` runs there, on the test's MCP
 * connection; other clients connect to servers themselves, which a suite
 * configures. A different client's options don't carry over.
 */
export function playwrightClientOf(
  evalCase: EvalCase,
  run: ClientFields | undefined
): { model?: string } & Record<string, unknown> {
  const client = evalCase.client ?? run?.client ?? 'mst';
  if (client !== 'mst')
    throw new Error(
      `Case "${evalCase.id}" uses client "${client}". Outside a suite, cases run on the mst client, on the test's MCP connection. Run "${client}" in a suite (mst run).`
    );
  const inherits = (run?.client ?? 'mst') === 'mst';
  const model = evalCase.model ?? (inherits ? run?.model : undefined);
  return {
    ...(inherits ? run?.clientOptions : undefined),
    ...evalCase.clientOptions,
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Run a case against the fixture: a direct tool call or request, or the mst
 * client on the test's connection. Failures become a `failed` execution.
 */
export async function executeEvalCase(
  evalCase: EvalCase,
  mcp: MCPFixtureApi | undefined,
  client?: ClientFields
): Promise<CaseExecution> {
  try {
    if (isClientCase(evalCase)) {
      if (!mcp) throw new Error('The mst client requires an MCP connection.');
      if (!evalCase.input)
        throw new Error(`Eval case ${evalCase.id}: a client case needs input`);
      const config = getBuiltinHostConfig(
        'mst',
        playwrightClientOf(evalCase, client)
      );
      const simulation = withOriginalToolNames(
        await simulateMCPHost(mcp, evalCase.input, config),
        mcp
      );
      if (simulation.success) return simulationExecution(simulation);
      throw new Error(simulation.error || 'The mst client failed.');
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
  host: ClientConfig;
  manifest: EvalManifest;
  arm?: EvalArm;
  env?: Record<string, string | undefined>;
  /** Traces from a batch host, consumed once per case iteration. */
  batchTraces?: Map<string, ClientRunResult[]>;
  /** Called with each per-case direct connection, e.g. to record its protocol. */
  onDirectConnection?: (client: Client) => void;
  /** The arm's tool variant, which `proxy` serves to hosts that connect to their servers. */
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> };
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
    // The suite resolves a case's own client in full (see runEvalSuite).
    const declaration =
      (clientPatchOf(evalCase) as ClientConfig | undefined) ?? options.host;
    if (!isClientCase(evalCase)) {
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
        ...hostRunToExecution(trace, definition.evidence ?? 'none', servers),
        preExecutionDurationMs: trace.durationMs,
      };
    }
    if (!definition.run)
      throw new Error(
        `Host ${declaration.type} must expose run() for per-case dispatch.`
      );
    const context = { manifest, arm, env };
    if (options.toolVariant && usesToolSurfaceProxy(definition)) {
      const proxy = await options.toolVariant.proxy();
      const scope = randomUUID();
      const checkScope = randomUUID();
      const trace = await definition.run(
        {
          prompt: evalCase.input ?? '',
          servers: proxy.serversFor(scope),
          checkServers: proxy.serversFor(checkScope),
          env,
        },
        declaration,
        withoutToolVariant(context)
      );
      proxy.endScope(checkScope);
      return hostRunToExecution(
        settleProxiedTrace(
          trace,
          proxy,
          proxy.endScope(scope).listedTools,
          servers,
          options.toolVariant.id
        ),
        definition.evidence ?? 'none',
        servers
      );
    }
    const trace = await definition.run(
      { prompt: evalCase.input ?? '', servers, env },
      declaration,
      context
    );
    return hostRunToExecution(trace, definition.evidence ?? 'none', servers);
  };
}
