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
import {
  settleProxiedTrace,
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';

/**
 * The trace for a request whose batch failed before running it: an
 * infrastructure failure that says why, so the run keeps its other results.
 */
function batchFailure(client: string, error: unknown): ClientRunResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    finalText: '',
    events: [],
    error: `Not run: the ${client} batch failed before this case ran: ${reason}`,
    diagnostics: { failureKind: 'not-submitted' },
    telemetry: {
      caseExecution: { status: 'not-submitted', continuation: 'blocked' },
    },
  };
}

/**
 * Pre-execute a batch client, retaining per-case trial queues for the evaluator.
 *
 * A batch that fails before returning traces (its setup, a desktop lease held
 * by an earlier batch) gives every request an infrastructure failure instead
 * of throwing, so an eval keeps the variants that did run. A batch client
 * returns the traces of cases it ran even when it stops early.
 */
export async function prepareClientBatch(
  definition: ClientDefinition,
  cases: EvalCase[],
  config: ClientConfig,
  servers: MCPConfig[],
  context: ClientRunContext,
  toolVariant?: { id: string; proxy: () => Promise<ToolSurfaceProxy> }
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
  const failAll = (error: unknown): Map<string, ClientRunResult[]> => {
    console.warn(
      `[mst] The ${config.type} batch${context.variant ? ` for variant "${context.variant.name}"` : ''} failed before its cases ran: ${error instanceof Error ? error.message : String(error)}`
    );
    for (const request of requests)
      queues.get(request.caseId)!.push(batchFailure(config.type, error));
    return queues;
  };
  // Proxied clients connect to the variant's servers, one scope per request.
  let started: ToolSurfaceProxy | undefined;
  try {
    started =
      toolVariant && usesToolSurfaceProxy(definition)
        ? await toolVariant.proxy()
        : undefined;
  } catch (error) {
    return failAll(error);
  }
  const proxy = started;
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
  let traces: ClientRunResult[];
  try {
    traces = await definition.runBatch(
      requests,
      proxy ? withoutToolVariant(context) : context
    );
  } catch (error) {
    return failAll(error);
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
