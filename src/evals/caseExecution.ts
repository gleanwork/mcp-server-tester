/**
 * Case execution: the one place an eval case runs.
 *
 * Every path (the api client on a Playwright test's connection, or an eval's
 * client) produces a `CaseExecution`. The
 * runner reads its explicit fields and never inspects `response` to guess how
 * a case ran. Clients and adapters produce transcripts; the runner owns every score.
 */
import { randomUUID } from 'node:crypto';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type {
  ClientDiagnostics,
  SkillLoad,
  TrialEnding,
  UsageMetrics,
} from '../types/index.js';
import type { EvalCase } from './datasetTypes.js';
import { settingsFor } from '../plugins/settings.js';
import type { EvalVariant, EvalConfig, ClientConfig } from './evalConfig.js';
import { clientPatchOf, type ClientFields } from './clientFields.js';
import type {
  TranscriptEvent,
  TranscriptEvidence,
  ClientDefinition,
  ClientRunInput,
  ClientRunContext,
  ClientArtifacts,
  ClientRunResult,
  HostTelemetry,
  ModelCall,
  Transcript,
} from './evalFrameworkTypes.js';
import type { ClientMetadata } from './clientTelemetryTypes.js';
import { getBuiltinClientConfig, getClient } from './builtinClients.js';
import { bareClientName, resolveClientName } from './clientNames.js';
import { clientRunToExecution } from './clientTranscript.js';
import { clientSecretValues, redactedClientRun } from './clientSecrets.js';
import { withOriginalToolNames } from './toolSurface.js';
import {
  settleProxiedTranscript,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { runApiClient } from './mstClient/run.js';
import type { LLMToolCall } from './mstClient/types.js';
import { endingOf, thrownEnding } from './trialEnding.js';
import { readinessSetup, readyBatch } from './readinessCheck.js';
import { batchName } from './prepareClientBatch.js';
import { collectClientBatch } from './desktopBatch.js';

/** The assertion/report view. Custom executors may return this view directly. */
export interface ClientResponse {
  success: boolean;
  response?: string;
  toolCalls: LLMToolCall[];
  events?: TranscriptEvent[];
  evidence?: TranscriptEvidence;
  error?: string;
  ending?: TrialEnding;
  usage?: UsageMetrics;
  modelCalls?: ModelCall[];
  hostTelemetry?: HostTelemetry;
  llmDurationMs?: number;
  mcpDurationMs?: number;
  skillLoads?: SkillLoad[];
  telemetry?: Record<string, unknown>;
  diagnostics?: ClientDiagnostics;
  clientMetadata?: ClientMetadata;
  /** Legacy custom-executor content; built-in clients use telemetry.content. */
  input?: string;
  conversationHistory?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    toolCallId?: string;
  }>;
  /** See `ClientRunResult.artifacts`. Never stored in results. */
  artifacts?: ClientArtifacts;
}

interface ExecutionBase {
  /** Set when execution failed; assertions are not evaluated. */
  error?: string;
  /** Client time spent before the runner's timer started (batch transcripts). */
  preExecutionDurationMs?: number;
  /**
   * How the attempt ended (ADR 0010), when its producer said. Otherwise
   * `executionEnding` reads it from the execution's failure kinds and error.
   */
  ending?: TrialEnding;
}

/** A client run with its assertion/report view. */
export interface ClientExecution extends ExecutionBase {
  kind: 'completed';
  response: ClientResponse;
  /**
   * What the client did, as it reported it: its transcript. A custom executor
   * may omit it; the runner then derives it from `response`.
   */
  transcript?: Transcript;
  /** Declared transcript evidence. Custom executors may omit it. */
  evidence?: TranscriptEvidence;
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
    const run = withOriginalToolNames(
      await runApiClient(mcp, evalCase.input, config),
      mcp
    );
    if (!run.error) return clientRunToExecution(run, 'structured');
    // Keep the Playwright API's failed-execution contract and the producer's
    // ending. Eval clients retain failed runs and their partial transcripts.
    return {
      kind: 'failed',
      response: undefined,
      error: run.error,
      ending:
        run.ending ??
        endingOf({ error: run.error, diagnostics: run.diagnostics }),
    };
  } catch (error) {
    // Client errors are already enriched by the producer; pass them through.
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
  /** Transcripts from a batch client, consumed once per case trial. */
  batchTranscripts?: Map<string, ClientRunResult[]>;
  /** The variant's tool metadata, which `proxy` serves to clients that connect to their servers. */
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> };
  /**
   * Values no stored result may hold besides the credential-like `env` values
   * and the servers' credentials, which the executor finds itself: a secrets
   * file's values and connector tokens, as they are now.
   */
  secrets?: () => readonly string[];
}

/** How a run a batch client returned went: the execution the case grades. */
export function batchTranscriptExecution(
  transcript: ClientRunResult,
  definition: ClientDefinition,
  servers: MCPConfig[]
): CaseExecution {
  return {
    ...clientRunToExecution(transcript, definition.evidence ?? 'none', servers),
    preExecutionDurationMs: transcript.durationMs,
  };
}

/**
 * The eval's per-case executor for clients with `run()` or `open()`:
 * a case consumes a collected transcript or runs on its own client.
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
  const { servers, evalConfig, variant, env, batchTranscripts } = options;
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
  const trials = new Map<string, number>();
  return async (evalCase) => {
    // The eval resolves a case's own client in full (see runEval).
    const declaration =
      (clientPatchOf(evalCase) as ClientConfig | undefined) ?? options.client;
    const definition = getClient(declaration.type);
    const notReadyResult = batchTranscripts
      ? undefined
      : await notReady(definition, declaration.type);
    if (notReadyResult)
      return clientRunToExecution(
        notReadyResult(),
        definition.evidence ?? 'none',
        servers
      );
    if (batchTranscripts) {
      const transcript = batchTranscripts.get(evalCase.id)?.shift();
      if (!transcript)
        throw new Error(
          'Batch transcript already consumed or missing; refusing to resubmit.'
        );
      return batchTranscriptExecution(transcript, definition, servers);
    }
    const trial = trials.get(evalCase.id) ?? 0;
    trials.set(evalCase.id, trial + 1);
    const context = {
      evalConfig,
      variant,
      env,
      settings: settingsFor(evalConfig.settings, declaration.type),
    };
    const run = async (input: ClientRunInput, runContext: ClientRunContext) => {
      if (definition.open)
        return (
          await collectClientBatch(
            definition,
            [{ caseId: evalCase.id, trial, input, config: declaration }],
            runContext
          )
        )[0]!;
      if (!definition.run)
        throw new Error(`Client ${declaration.type} needs run() or open().`);
      return definition.run(input, declaration, runContext);
    };
    if (options.toolVariant && usesToolSurfaceProxy(definition)) {
      const proxy = await options.toolVariant.proxy();
      const scope = randomUUID();
      const checkScope = randomUUID();
      const transcript = await timed(() =>
        run(
          {
            prompt: evalCase.input ?? '',
            servers: proxy.serversFor(scope),
            checkServers: proxy.serversFor(checkScope),
            env,
          },
          withoutToolVariant(context)
        )
      );
      proxy.endScope(checkScope);
      return clientRunToExecution(
        settleProxiedTranscript(
          transcript,
          proxy,
          proxy.endScope(scope).listedTools,
          servers,
          options.toolVariant.id
        ),
        definition.evidence ?? 'none',
        servers
      );
    }
    const transcript = await timed(() =>
      run({ prompt: evalCase.input ?? '', servers, env }, context)
    );
    return clientRunToExecution(
      transcript,
      definition.evidence ?? 'none',
      servers
    );
  };
}

/** A `run`'s result, with when it started and ended unless the client said. */
async function timed(
  run: () => Promise<ClientRunResult>
): Promise<ClientRunResult> {
  const startedAt = new Date().toISOString();
  const transcript = await run();
  return {
    ...transcript,
    startedAt: transcript.startedAt ?? startedAt,
    completedAt: transcript.completedAt ?? new Date().toISOString(),
  };
}
