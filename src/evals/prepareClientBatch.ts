import { randomUUID } from 'node:crypto';
import { stableJson } from '../skills/skillEntry.js';
import type { EvalCase } from './datasetTypes.js';
import type { ClientConfig } from './evalConfig.js';
import { clientPatchOf } from './clientFields.js';
import { settingsFor } from '../plugins/settings.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientBatchRequest,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isClientUnavailable } from './clientUnavailable.js';
import { readyBatch } from './readinessCheck.js';
import { collectClientBatch } from './desktopBatch.js';
import { clientSecretValues, redactClientError } from './clientSecrets.js';
import { BatchWriteRecords, WriteRecordLedger } from './writeRecord.js';
import { readOnlyServerLabels } from './writeModes.js';
import {
  settleProxiedTranscript,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';

/**
 * The transcript for a request whose client was unavailable: an infrastructure
 * failure that says why, so the run keeps its other results.
 */
function batchFailure(client: string, reason: string): ClientRunResult {
  return {
    finalText: '',
    events: [],
    error: `Not run: the ${client} client was unavailable: ${reason}`,
    diagnostics: { failureKind: 'not-submitted' },
    telemetry: {
      caseExecution: { status: 'not-submitted', continuation: 'blocked' },
    },
  };
}

/** A batch in messages: `The api batch for variant "baseline"`. */
export function batchName(
  client: string,
  context: Pick<ClientRunContext, 'variant'>
): string {
  return `The ${client} batch${context.variant ? ` for variant "${context.variant.name}"` : ''}`;
}

/**
 * One request per trial of each case: what a batch client is given, and what
 * a shard's worker runs. A case's own client replaces `config` for it.
 */
export function batchRequests(
  cases: readonly EvalCase[],
  config: ClientConfig,
  servers: MCPConfig[],
  context: Pick<ClientRunContext, 'evalConfig' | 'env'>
): ClientBatchRequest[] {
  const requests: ClientBatchRequest[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id))
      throw new Error('Batch client case IDs must be unique within a dataset.');
    seen.add(c.id);
    // The eval resolves a case's own client in full (see runEval).
    const declaration =
      (clientPatchOf(c) as ClientConfig | undefined) ?? config;
    const trials = c.trials ?? context.evalConfig.trials ?? 1;
    for (let trial = 0; trial < trials; trial++)
      requests.push({
        caseId: c.id,
        trial,
        config: declaration,
        input: {
          prompt: c.input ?? '',
          servers,
          ...(context.env ? { env: context.env } : {}),
        },
      });
  }
  return requests;
}

/** A batch's requests pointed at a tool-variant proxy, and how to settle their transcripts. */
export interface ProxiedBatch {
  /** The requests, each connecting to the proxy. */
  requests: ClientBatchRequest[];
  /**
   * A request's transcript, with tool calls under their original names. Before
   * the request is over (`final: false`) it is settled with the traffic so
   * far; `final` ends the request's scope.
   */
  settle(
    index: number,
    transcript: ClientRunResult,
    final: boolean
  ): ClientRunResult;
  /** Ends the scope of the client's own checks, once the batch has run. */
  endChecks(): void;
}

/**
 * Points `requests` at `proxy`: one scope per request, or one for the batch
 * when the client connects to one server set per batch (`serversPerBatch`).
 * A local run and a shard's worker both settle transcripts this way.
 */
export function proxiedBatch(
  definition: ClientDefinition,
  requests: readonly ClientBatchRequest[],
  proxy: ToolSurfaceProxy,
  servers: readonly MCPConfig[],
  variantId: string
): ProxiedBatch {
  const shared =
    definition.open !== undefined || definition.serversPerBatch === true;
  const sessionScopes = new Map<string, string>();
  const scopes = requests.map((request) => {
    if (!shared) return randomUUID();
    const { prompt: _prompt, ...input } = request.input;
    const key = definition.open
      ? stableJson({ config: request.config, input })
      : '';
    let scope = sessionScopes.get(key);
    if (!scope) sessionScopes.set(key, (scope = randomUUID()));
    return scope;
  });
  const checkScope = randomUUID();
  const batchListed = new Map<string, boolean>();
  return {
    requests: requests.map((request, index) => ({
      ...request,
      input: {
        ...request.input,
        servers: proxy.serversFor(scopes[index]!),
        checkServers: proxy.serversFor(checkScope),
      },
    })),
    settle(index, transcript, final) {
      const scope = scopes[index]!;
      let listedTools: boolean;
      if (!final) listedTools = proxy.activity(scope).listedTools;
      else if (shared) {
        if (!batchListed.has(scope))
          batchListed.set(scope, proxy.endScope(scope).listedTools);
        listedTools = batchListed.get(scope)!;
      } else listedTools = proxy.endScope(scope).listedTools;
      return settleProxiedTranscript(
        transcript,
        proxy,
        listedTools,
        servers,
        variantId
      );
    },
    endChecks() {
      proxy.endScope(checkScope);
    },
  };
}

/** What else a batch does while it runs. */
export interface ClientBatchOptions {
  /**
   * Secrets to replace in every transcript besides the environment's and the
   * servers' (a secrets file's values, connector tokens). Read when each
   * transcript arrives, so a token renewed mid-batch is included.
   */
  secrets?: () => readonly string[];
  /**
   * Receives each transcript the client reports before its batch ends, settled
   * like the transcripts the batch returns. A failure is printed, not thrown.
   */
  onTranscript?: (
    request: ClientBatchRequest,
    transcript: ClientRunResult
  ) => Promise<void>;
  /**
   * The run's write record files: each transcript gets the writes its trial's
   * proxies recorded (ADR 0014).
   */
  writeRecords?: WriteRecordLedger;
}

/**
 * Pre-execute a batch client, retaining per-case trial queues for the evaluator.
 *
 * A batch whose client is unavailable ({@link ClientUnavailableError}: a
 * desktop still leased by an earlier batch, say) gives every request an
 * infrastructure failure instead of throwing, so an eval goes on with its
 * other variants. Any other error stops the run. A batch client returns the
 * transcripts of cases it ran even when it stops early.
 */
export async function prepareClientBatch(
  definition: ClientDefinition,
  cases: EvalCase[],
  config: ClientConfig,
  servers: MCPConfig[],
  context: ClientRunContext,
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> },
  options: ClientBatchOptions = {}
): Promise<Map<string, ClientRunResult[]> | undefined> {
  if (!definition.open) return undefined;
  for (const c of cases) {
    const declaration =
      (clientPatchOf(c) as ClientConfig | undefined) ?? config;
    if (declaration.type !== config.type)
      throw new Error(
        'A batch client dataset cannot mix client types. Use separate eval configs.'
      );
  }
  const queues = new Map<string, ClientRunResult[]>(
    cases.map((c) => [c.id, []])
  );
  const declared = batchRequests(cases, config, servers, context);
  if (!declared.length) return queues;
  const { onTranscript } = options;
  // Every transcript a batch client hands MST, early or at the end, has no secret
  // in it before it is settled, saved or graded.
  const secrets = (): string[] => [
    ...clientSecretValues(context.env ?? {}, servers),
    ...(options.secrets?.() ?? []),
  ];
  // Each transcript gets its trial's write record. The batch runs one trial at a
  // time, so each window closes when the next trial starts.
  const records = new BatchWriteRecords(
    options.writeRecords ?? new WriteRecordLedger([]),
    secrets
  );
  const received = (
    index: number | undefined,
    transcript: ClientRunResult
  ): Promise<ClientRunResult> =>
    records.attach(index === undefined ? 'none' : String(index), transcript);
  // MST's readiness check, before the batch's first trial and before the
  // proxy starts. Proxied clients connect to the variant's servers through
  // the proxy.
  const ready = await readyBatch(
    definition,
    servers,
    toolVariant && usesToolSurfaceProxy(definition)
      ? toolVariant.proxy
      : undefined,
    {
      ...(context.env ? { env: context.env } : {}),
      batch: batchName(config.type, context),
      readOnly: readOnlyServerLabels(servers, context.evalConfig.writes),
    }
  );
  if (ready.notReady) {
    for (const request of declared)
      queues
        .get(request.caseId)!
        .push(await received(undefined, ready.notReady()));
    return queues;
  }
  const proxied = ready.proxy
    ? proxiedBatch(definition, declared, ready.proxy, servers, toolVariant!.id)
    : undefined;
  const requests = proxied?.requests ?? declared;
  // A transcript reported early is settled with the proxy's traffic so far;
  // the batch's returned transcripts are settled again when it ends.
  const reportResult = onTranscript
    ? async (index: number, reported: ClientRunResult): Promise<void> => {
        const request = requests[index];
        if (!request) return;
        try {
          const transcript = await received(index, reported);
          await onTranscript(
            request,
            proxied ? proxied.settle(index, transcript, false) : transcript
          );
        } catch (error) {
          console.warn(
            `[mst] Couldn't save the transcript of ${request.caseId} (trial ${request.trial}) before the batch ended: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    : undefined;
  const withSettings: ClientRunContext = {
    ...context,
    settings: settingsFor(context.evalConfig.settings, config.type),
  };
  const contextAcquire = context.acquire;
  const batchContext: ClientRunContext = {
    ...(proxied ? withoutToolVariant(withSettings) : withSettings),
    acquire: async (index: number): Promise<void> => {
      await contextAcquire?.(index);
      await records.begin(String(index));
    },
  };
  let transcripts: ClientRunResult[];
  try {
    transcripts = await collectClientBatch(
      definition,
      requests,
      reportResult ? { ...batchContext, reportResult } : batchContext,
      secrets()
    );
  } catch (error) {
    if (!isClientUnavailable(error)) throw error;
    // The message is stored: never with a credential in it.
    const reason = redactClientError(error, secrets(), 'client unavailable');
    console.warn(
      `[mst] ${batchName(config.type, context)} didn't run: ${reason}`
    );
    for (const request of requests)
      queues.get(request.caseId)!.push(batchFailure(config.type, reason));
    return queues;
  } finally {
    proxied?.endChecks();
  }
  if (transcripts.length !== requests.length)
    throw new Error(
      'Batch client returned an incomplete transcript set; refusing to resubmit.'
    );
  for (const [index, request] of requests.entries()) {
    const transcript = await received(index, transcripts[index]!);
    queues
      .get(request.caseId)!
      .push(proxied ? proxied.settle(index, transcript, true) : transcript);
  }
  return queues;
}
