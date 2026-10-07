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

/** Pre-execute a batch client, retaining per-case trial queues for the evaluator. */
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
  const traces = await definition.runBatch(
    requests,
    proxy ? withoutToolVariant(context) : context
  );
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
