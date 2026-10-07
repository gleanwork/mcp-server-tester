/**
 * Case execution: the one place an eval case runs.
 *
 * Every path (the mst client on a Playwright test's connection, or a suite's
 * client) produces a `CaseExecution`. The
 * runner reads its explicit fields and never inspects `response` to guess how
 * a case ran. Hosts and adapters produce traces; the runner owns every verdict.
 */
import { randomUUID } from 'node:crypto';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { ClientDiagnostics, UsageMetrics } from '../types/index.js';
import type { EvalCase } from './datasetTypes.js';
import type { EvalVariant, EvalConfig, ClientConfig } from './evalConfig.js';
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

/** How one trial of a case ran. */
export type CaseExecution = HostExecution | FailedExecution;

const EXECUTION_KINDS = new Set<unknown>(['host', 'failed']);

/**
 * Reject a custom executor's result that lacks a known `kind`. A pre-2.0
 * `{ response }`, or a `direct` execution, must fail loudly rather than be
 * graded as something it isn't.
 */
export function checkedExecution(value: unknown): CaseExecution {
  const kind =
    typeof value === 'object' && value !== null
      ? (value as { kind?: unknown }).kind
      : undefined;
  if (EXECUTION_KINDS.has(kind)) return value as CaseExecution;
  return failedExecution(
    new Error(
      "executeCase must return a CaseExecution with kind 'host' or 'failed'. See the 2.0 migration guide."
    )
  );
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
 * Run a case on the mst client, on the Playwright test's connection.
 * Failures become a `failed` execution.
 */
export async function executeEvalCase(
  evalCase: EvalCase,
  mcp: MCPFixtureApi | undefined,
  client?: ClientFields
): Promise<CaseExecution> {
  try {
    if (!mcp) throw new Error('The mst client requires an MCP connection.');
    if (!evalCase.input)
      throw new Error(`Eval case ${evalCase.id}: a case needs input`);
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
  } catch (error) {
    // Simulation errors are already enriched by the adapter; pass them through.
    return failedExecution(error);
  }
}

/** Everything a suite needs to run one case of one variant. */
export interface SuiteCaseExecutorOptions {
  servers: MCPConfig[];
  host: ClientConfig;
  evalConfig: EvalConfig;
  variant?: EvalVariant;
  env?: Record<string, string | undefined>;
  /** Traces from a batch host, consumed once per case iteration. */
  batchTraces?: Map<string, ClientRunResult[]>;
  /** The variant's tool metadata, which `proxy` serves to clients that connect to their servers. */
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> };
}

/**
 * The suite's per-case executor for clients with `run()` or `runBatch()`:
 * a case consumes a batch trace or calls the client's `run()`.
 */
export function createSuiteCaseExecutor(
  options: SuiteCaseExecutorOptions
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const { servers, evalConfig, variant, env, batchTraces } = options;
  return async (evalCase) => {
    // The suite resolves a case's own client in full (see runEvalSuite).
    const declaration =
      (clientPatchOf(evalCase) as ClientConfig | undefined) ?? options.host;
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
    const context = { evalConfig, variant, env };
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
