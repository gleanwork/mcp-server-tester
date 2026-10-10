import { randomUUID } from 'node:crypto';
import type { EvalCase } from './datasetTypes.js';
import type { ClientConfig } from './evalConfig.js';
import { clientPatchOf } from './clientFields.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientBatchRequest,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isClientUnavailable } from './clientUnavailable.js';
import { clientSecretValues, redactClientError } from './clientSecrets.js';
import {
  settleProxiedTrace,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';

/**
 * The trace for a request whose client was unavailable: an infrastructure
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

/** A batch's requests pointed at a tool-variant proxy, and how to settle their traces. */
export interface ProxiedBatch {
  /** The requests, each connecting to the proxy. */
  requests: ClientBatchRequest[];
  /**
   * A request's trace, with tool calls under their original names. Before
   * the request is over (`final: false`) it is settled with the traffic so
   * far; `final` ends the request's scope.
   */
  settle(
    index: number,
    trace: ClientRunResult,
    final: boolean
  ): ClientRunResult;
  /** Ends the scope of the client's own checks, once the batch has run. */
  endChecks(): void;
}

/**
 * Points `requests` at `proxy`: one scope per request, or one for the batch
 * when the client connects to one server set per batch (`serversPerBatch`).
 * A local run and a shard's worker both settle traces this way.
 */
export function proxiedBatch(
  definition: ClientDefinition,
  requests: readonly ClientBatchRequest[],
  proxy: ToolSurfaceProxy,
  servers: readonly MCPConfig[],
  variantId: string
): ProxiedBatch {
  const shared = definition.serversPerBatch === true;
  const scopes = requests.map(() => randomUUID());
  if (shared) scopes.fill(scopes[0]!);
  const checkScope = randomUUID();
  let batchListed: boolean | undefined;
  return {
    requests: requests.map((request, index) => ({
      ...request,
      input: {
        ...request.input,
        servers: proxy.serversFor(scopes[index]!),
        checkServers: proxy.serversFor(checkScope),
      },
    })),
    settle(index, trace, final) {
      const scope = scopes[index]!;
      const listedTools = !final
        ? proxy.activity(scope).listedTools
        : shared
          ? (batchListed ??= proxy.endScope(scope).listedTools)
          : proxy.endScope(scope).listedTools;
      return settleProxiedTrace(trace, proxy, listedTools, servers, variantId);
    },
    endChecks() {
      proxy.endScope(checkScope);
    },
  };
}

/** What else a batch does while it runs. */
export interface ClientBatchOptions {
  /**
   * Receives each trace the client reports before its batch ends, settled
   * like the traces the batch returns. A failure is printed, not thrown.
   */
  onTrace?: (
    request: ClientBatchRequest,
    trace: ClientRunResult
  ) => Promise<void>;
}

/**
 * Pre-execute a batch client, retaining per-case trial queues for the evaluator.
 *
 * A batch whose client is unavailable ({@link ClientUnavailableError}: a
 * desktop still leased by an earlier batch, say) gives every request an
 * infrastructure failure instead of throwing, so an eval goes on with its
 * other variants. Any other error stops the run. A batch client returns the
 * traces of cases it ran even when it stops early.
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
  if (!definition.runBatch) return undefined;
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
  // Proxied clients connect to the variant's servers through the proxy.
  const proxied =
    toolVariant && usesToolSurfaceProxy(definition)
      ? proxiedBatch(
          definition,
          declared,
          await toolVariant.proxy(),
          servers,
          toolVariant.id
        )
      : undefined;
  const requests = proxied?.requests ?? declared;
  const { onTrace } = options;
  // A trace reported early is settled with the proxy's traffic so far; the
  // batch's returned traces are settled again when it ends.
  const reportResult = onTrace
    ? async (index: number, trace: ClientRunResult): Promise<void> => {
        const request = requests[index];
        if (!request) return;
        try {
          await onTrace(
            request,
            proxied ? proxied.settle(index, trace, false) : trace
          );
        } catch (error) {
          console.warn(
            `[mst] Couldn't save the trace of ${request.caseId} (trial ${request.trial}) before the batch ended: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    : undefined;
  const batchContext = proxied ? withoutToolVariant(context) : context;
  let traces: ClientRunResult[];
  try {
    traces = await definition.runBatch(
      requests,
      reportResult ? { ...batchContext, reportResult } : batchContext
    );
  } catch (error) {
    if (!isClientUnavailable(error)) throw error;
    // The message is stored: never with a credential in it.
    const reason = redactClientError(
      error,
      clientSecretValues(context.env ?? {}, servers),
      'client unavailable'
    );
    console.warn(
      `[mst] The ${config.type} batch${context.variant ? ` for variant "${context.variant.name}"` : ''} didn't run: ${reason}`
    );
    for (const request of requests)
      queues.get(request.caseId)!.push(batchFailure(config.type, reason));
    return queues;
  }
  proxied?.endChecks();
  if (traces.length !== requests.length)
    throw new Error(
      'Batch client returned an incomplete trace set; refusing to resubmit.'
    );
  requests.forEach((request, index) =>
    queues
      .get(request.caseId)!
      .push(
        proxied ? proxied.settle(index, traces[index]!, true) : traces[index]!
      )
  );
  return queues;
}
