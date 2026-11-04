/**
 * Case execution: the one place an eval case runs.
 *
 * Every path (the api client on a Playwright test's connection, or an eval's
 * client) produces a `CaseExecution`. The
 * runner reads its explicit fields and never inspects `response` to guess how
 * a case ran. Clients and adapters produce traces; the runner owns every score.
 */
import { randomUUID } from 'node:crypto';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type {
  ClientDiagnostics,
  TrialEnding,
  UsageMetrics,
} from '../types/index.js';
import type { EvalCase } from './datasetTypes.js';
import { settingsFor } from '../plugins/settings.js';
import type { EvalVariant, EvalConfig, ClientConfig } from './evalConfig.js';
import { clientPatchOf, type ClientFields } from './clientFields.js';
import type {
  TraceEvent,
  TraceEvidence,
  ClientDefinition,
  ClientArtifacts,
  ClientRunResult,
  Trace,
} from './evalFrameworkTypes.js';
import type {
  ClientMetadata,
  ExternalClientSimulationResult,
} from './externalClient/types.js';
import { getBuiltinClientConfig, getClient } from './builtinClients.js';
import { bareClientName, resolveClientName } from './clientNames.js';
import { clientRunToExecution, simulationTrace } from './clientTrace.js';
import { clientSecretValues, redactedClientRun } from './clientSecrets.js';
import { withOriginalToolNames } from './toolSurface.js';
import {
  settleProxiedTrace,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { simulateMstClient } from './mstClient/simulation.js';
import type { MstClientSimulationResult } from './mstClient/types.js';
import { endingOf, thrownEnding } from './trialEnding.js';
import { readinessSetup, readyBatch } from './readinessCheck.js';
import { batchName } from './prepareClientBatch.js';

/** The client payload validators and reports read: the simulation shape. */
export type ClientResponse = MstClientSimulationResult & {
  events?: TraceEvent[];
  evidence?: TraceEvidence;
  clientMetadata?: ClientMetadata;
  /** See `ClientRunResult.artifacts`. Never stored in results. */
  artifacts?: ClientArtifacts;
};

interface ExecutionBase {
  /** Set when execution failed; assertions are not evaluated. */
  error?: string;
  /** Client time spent before the runner's timer started (batch traces). */
  preExecutionDurationMs?: number;
  /**
   * How the attempt ended (ADR 0010), when its producer said. Otherwise
   * `executionEnding` reads it from the execution's failure kinds and error.
   */
  ending?: TrialEnding;
}

/** An LLM or desktop client run, adapted to the simulation-shaped response. */
export interface ClientExecution extends ExecutionBase {
  kind: 'completed';
  response: ClientResponse;
  /**
   * What the client did, as it reported it. A custom executor may omit it;
   * the runner then derives it from `response`.
   */
  trace?: Trace;
  /** Declared trace evidence. Undefined for the legacy simulated client. */
  evidence?: TraceEvidence;
  usage?: UsageMetrics;
  telemetry?: Record<string, unknown>;
  diagnostics?: ClientDiagnostics;
  clientMetadata?: ClientMetadata;
}

/** Execution threw before producing a result. */
export interface FailedExecution extends ExecutionBase {
  kind: 'failed';
  response: undefined;
  error: string;
}

/** How one trial of a case ran. */
export type CaseExecution = ClientExecution | FailedExecution;

const EXECUTION_KINDS = new Set<unknown>(['completed', 'failed']);

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
      "executeCase must return a CaseExecution with kind 'completed' or 'failed'. See the 2.0 migration guide."
    )
  );
}

export function failedExecution(error: unknown): FailedExecution {
  return {
    kind: 'failed',
    response: undefined,
    error: error instanceof Error ? error.message : String(error),
    ending: thrownEnding(error),
  };
}

/**
 * How an execution's attempt ended: the one place a producer's ending
 * becomes the trial's (ADR 0010). The producer's when it gave one, else the
 * ending its failure kinds and error say.
 */
export function executionEnding(execution: CaseExecution): TrialEnding {
  if (execution.ending) return execution.ending;
  const response = execution.response;
  return endingOf({
    error:
      execution.error ??
      (response && !response.success
        ? (response.error ?? 'Client execution failed.')
        : undefined),
    diagnostics:
      execution.kind === 'completed'
        ? (execution.diagnostics ?? response?.diagnostics)
        : undefined,
    clientMetadata:
      execution.kind === 'completed'
        ? (execution.clientMetadata ?? response?.clientMetadata)
        : undefined,
  });
}

/** Adapt a simulated (SDK/CLI/browser) or external client result. */
function simulationExecution(
  result: MstClientSimulationResult | ExternalClientSimulationResult,
  error?: string
): ClientExecution {
  return {
    kind: 'completed',
    response: result,
    trace: simulationTrace(result),
    ...(error !== undefined ? { error } : {}),
    ...(result.ending ? { ending: result.ending } : {}),
    usage: result.usage,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...('clientMetadata' in result && result.clientMetadata
      ? { clientMetadata: result.clientMetadata }
      : {}),
  };
}

/**
 * The client a case runs on outside an eval: its own `client`, `model` and
 * `clientOptions` over the run's. Only `api` runs there, on the test's MCP
 * connection; other clients connect to servers themselves, which an eval
 * configures. A different client's options don't carry over.
 */
export function playwrightClientOf(
  evalCase: EvalCase,
  run: ClientFields | undefined
): { model?: string } & Record<string, unknown> {
  // A built-in's full name (`mst/client/api`) is its bare name here.
  const clientName = (reference: string) =>
    bareClientName(resolveClientName(reference));
  const runClient = clientName(run?.client ?? 'api');
  const client = clientName(evalCase.client ?? runClient);
  if (client !== 'api')
    throw new Error(
      `Case "${evalCase.id}" uses client "${client}". Outside an eval, cases run on the api client, on the test's MCP connection. Run "${client}" in an eval (mst run).`
    );
  const inherits = runClient === 'api';
  const model = evalCase.model ?? (inherits ? run?.model : undefined);
  return {
    ...(inherits ? run?.clientOptions : undefined),
    ...evalCase.clientOptions,
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Run a case on the api client, on the Playwright test's connection.
 * Failures become a `failed` execution.
 */
export async function executeEvalCase(
  evalCase: EvalCase,
  mcp: MCPFixtureApi | undefined,
  client?: ClientFields
): Promise<CaseExecution> {
  try {
    if (!mcp) throw new Error('The api client requires an MCP connection.');
    if (!evalCase.input)
      throw new Error(`Eval case ${evalCase.id}: a case needs input`);
    const config = getBuiltinClientConfig(
      'api',
      playwrightClientOf(evalCase, client)
    );
    const simulation = withOriginalToolNames(
      await simulateMstClient(mcp, evalCase.input, config),
      mcp
    );
    if (simulation.success) return simulationExecution(simulation);
    // The adapter typed how it ended, or its failure kind says (a CLI that
    // didn't start); a thrown error would lose both.
    const error = simulation.error || 'The api client failed.';
    return {
      kind: 'failed',
      response: undefined,
      error,
      ending:
        simulation.ending ??
        endingOf({ error, diagnostics: simulation.diagnostics }),
    };
  } catch (error) {
    // Simulation errors are already enriched by the adapter; pass them through.
    return failedExecution(error);
  }
}

/** Everything an eval needs to run one case of one variant. */
export interface EvalCaseExecutorOptions {
  servers: MCPConfig[];
  client: ClientConfig;
  evalConfig: EvalConfig;
  variant?: EvalVariant;
  env?: Record<string, string | undefined>;
  /** Traces from a batch client, consumed once per case trial. */
  batchTraces?: Map<string, ClientRunResult[]>;
  /** The variant's tool metadata, which `proxy` serves to clients that connect to their servers. */
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> };
  /**
   * Values no stored result may hold besides the credential-like `env` values
   * and the servers' credentials, which the executor finds itself: a secrets
   * file's values and connector tokens, as they are now.
   */
  secrets?: () => readonly string[];
}

/** How a trace a batch client returned ran: the execution the case grades. */
export function batchTraceExecution(
  trace: ClientRunResult,
  definition: ClientDefinition,
  servers: MCPConfig[]
): CaseExecution {
  return {
    ...clientRunToExecution(trace, definition.evidence ?? 'none', servers),
    preExecutionDurationMs: trace.durationMs,
  };
}

/**
 * The eval's per-case executor for clients with `run()` or `runBatch()`:
 * a case consumes a batch trace or calls the client's `run()`.
 */
export function createEvalCaseExecutor(
  options: EvalCaseExecutorOptions
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const execute = clientExecutor(options);
  // Every client's result, and the error a `run` throws, with no secret in
  // it before it is graded or stored: one pass, whatever the client.
  return async (evalCase) => {
    let execution: CaseExecution;
    try {
      execution = await execute(evalCase);
    } catch (error) {
      execution = failedExecution(error);
    }
    return redactedClientRun(execution, [
      ...clientSecretValues(options.env ?? {}, options.servers),
      ...(options.secrets?.() ?? []),
    ]);
  };
}

function clientExecutor(
  options: EvalCaseExecutorOptions
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const { servers, evalConfig, variant, env, batchTraces } = options;
  // MST's readiness check for the executor's batch (a variant's cases of
  // one dataset), before its first trial, and before the proxy starts when
  // proxied. It follows the client each case runs on, which a case can name
  // itself: one check per setup (proxied, direct, or left to a client that
  // checks after it prepares its app), shared by the cases with that setup.
  // A batch client was checked before its batch ran.
  const readiness = new Map<
    string,
    Promise<(() => ClientRunResult) | undefined>
  >();
  const notReady = (definition: ClientDefinition, client: string) => {
    const startProxy =
      options.toolVariant && usesToolSurfaceProxy(definition)
        ? options.toolVariant.proxy
        : undefined;
    const setup = readinessSetup(definition, startProxy !== undefined);
    let ready = readiness.get(setup);
    if (!ready) {
      ready = readyBatch(definition, servers, startProxy, {
        ...(env ? { env } : {}),
        batch: batchName(client, { variant }),
      }).then((result) => result.notReady);
      readiness.set(setup, ready);
    }
    return ready;
  };
  return async (evalCase) => {
    // The eval resolves a case's own client in full (see runEval).
    const declaration =
      (clientPatchOf(evalCase) as ClientConfig | undefined) ?? options.client;
    const definition = getClient(declaration.type);
    const notReadyResult = batchTraces
      ? undefined
      : await notReady(definition, declaration.type);
    if (notReadyResult)
      return clientRunToExecution(
        notReadyResult(),
        definition.evidence ?? 'none',
        servers
      );
    if (batchTraces) {
      const trace = batchTraces.get(evalCase.id)?.shift();
      if (!trace)
        throw new Error(
          'Batch trace already consumed or missing; refusing to resubmit.'
        );
      return batchTraceExecution(trace, definition, servers);
    }
    if (!definition.run)
      throw new Error(
        `Client ${declaration.type} must expose run() for per-case dispatch.`
      );
    const context = {
      evalConfig,
      variant,
      env,
      settings: settingsFor(evalConfig.settings, declaration.type),
    };
    if (options.toolVariant && usesToolSurfaceProxy(definition)) {
      const proxy = await options.toolVariant.proxy();
      const scope = randomUUID();
      const checkScope = randomUUID();
      const trace = await timed(() =>
        definition.run!(
          {
            prompt: evalCase.input ?? '',
            servers: proxy.serversFor(scope),
            checkServers: proxy.serversFor(checkScope),
            env,
          },
          declaration,
          withoutToolVariant(context)
        )
      );
      proxy.endScope(checkScope);
      return clientRunToExecution(
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
    const trace = await timed(() =>
      definition.run!(
        { prompt: evalCase.input ?? '', servers, env },
        declaration,
        context
      )
    );
    return clientRunToExecution(trace, definition.evidence ?? 'none', servers);
  };
}

/** A `run`'s result, with when it started and ended unless the client said. */
async function timed(
  run: () => Promise<ClientRunResult>
): Promise<ClientRunResult> {
  const startedAt = new Date().toISOString();
  const trace = await run();
  return {
    ...trace,
    startedAt: trace.startedAt ?? startedAt,
    completedAt: trace.completedAt ?? new Date().toISOString(),
  };
}
