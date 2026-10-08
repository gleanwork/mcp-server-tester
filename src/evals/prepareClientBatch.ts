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
  const scopes: string[] = [];
  const requests: ClientBatchRequest[] = [];
  const queues = new Map<string, ClientRunResult[]>();
  for (const c of cases) {
    if (queues.has(c.id))
      throw new Error('Batch client case IDs must be unique within a dataset.');
    // The eval resolves a case's own client in full (see runEval).
    const declaration =
      (clientPatchOf(c) as ClientConfig | undefined) ?? config;
    if (declaration.type !== config.type)
      throw new Error(
        'A batch client dataset cannot mix client types. Use separate eval configs.'
      );
    queues.set(c.id, []);
    const trials = c.trials ?? context.evalConfig.trials ?? 1;
    for (let trial = 0; trial < trials; trial++) {
      const scope = randomUUID();
      scopes.push(scope);
      requests.push({
        caseId: c.id,
        trial,
        config: declaration,
        input: { prompt: c.input ?? '', servers, env: context.env },
      });
    }
  }
  if (!requests.length) return queues;
  // Proxied clients connect to the variant's servers, one scope per request.
  const proxy =
    toolVariant && usesToolSurfaceProxy(definition)
      ? await toolVariant.proxy()
      : undefined;
  // A client that connects to one server set for the batch shares one scope.
  const shared = proxy && definition.serversPerBatch;
  if (shared) scopes.fill(scopes[0]!);
  const checkScope = randomUUID();
  if (proxy) {
    requests.forEach((request, index) => {
      request.input = {
        ...request.input,
        servers: proxy.serversFor(scopes[index]!),
        checkServers: proxy.serversFor(checkScope),
      };
    });
  }
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
            proxy
              ? settleProxiedTrace(
                  trace,
                  proxy,
                  proxy.activity(scopes[index]!).listedTools,
                  servers,
                  toolVariant!.id
                )
              : trace
          );
        } catch (error) {
          console.warn(
            `[mst] Couldn't save the trace of ${request.caseId} (trial ${request.trial}) before the batch ended: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    : undefined;
  const batchContext = proxy ? withoutToolVariant(context) : context;
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
  if (proxy) proxy.endScope(checkScope);
  if (traces.length !== requests.length)
    throw new Error(
      'Batch client returned an incomplete trace set; refusing to resubmit.'
    );
  const batchListed = shared
    ? proxy.endScope(scopes[0]!).listedTools
    : undefined;
  requests.forEach((request, index) =>
    queues
      .get(request.caseId)!
      .push(
        proxy
          ? settleProxiedTrace(
              traces[index]!,
              proxy,
              batchListed ?? proxy.endScope(scopes[index]!).listedTools,
              servers,
              toolVariant!.id
            )
          : traces[index]!
      )
  );
  return queues;
}
