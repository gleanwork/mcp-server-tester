import { randomUUID } from 'node:crypto';
import type { EvalCase } from './datasetTypes.js';
import type { ClientConfig } from './evalManifest.js';
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

/** Pre-execute a batch host, retaining per-case iteration queues for the evaluator. */
export async function prepareHostBatch(
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
    if ((c.mode ?? 'direct') === 'direct') continue;
    if (c.mode === 'external_host')
      throw new Error(
        'Batch hosts require V2 host cases, not legacy external_host cases.'
      );
    if (queues.has(c.id))
      throw new Error('Batch host case IDs must be unique within a dataset.');
    // The suite resolves a case's own client in full (see runEvalSuite).
    const declaration =
      (clientPatchOf(c) as ClientConfig | undefined) ?? config;
    if (declaration.type !== config.type)
      throw new Error(
        'A batch host dataset cannot mix host types. Use separate manifests.'
      );
    queues.set(c.id, []);
    const trials = c.trials ?? context.manifest.trials ?? 1;
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
  // Proxied hosts connect to the variant's servers, one scope per request.
  const proxy =
    toolVariant && usesToolSurfaceProxy(definition)
      ? await toolVariant.proxy()
      : undefined;
  if (proxy) {
    requests.forEach((request, index) => {
      request.input = {
        ...request.input,
        servers: proxy.serversFor(scopes[index]!),
      };
    });
  }
  const traces = await definition.runBatch(
    requests,
    proxy ? withoutToolVariant(context) : context
  );
  if (traces.length !== requests.length)
    throw new Error(
      'Batch host returned an incomplete trace set; refusing to resubmit.'
    );
  requests.forEach((request, index) =>
    queues
      .get(request.caseId)!
      .push(
        proxy
          ? settleProxiedTrace(
              traces[index]!,
              proxy,
              scopes[index]!,
              servers,
              toolVariant!.id
            )
          : traces[index]!
      )
  );
  return queues;
}
