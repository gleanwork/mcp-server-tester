import type { EvalCase } from './datasetTypes.js';
import type { HostConfig } from './evalManifest.js';
import type {
  HostDefinition,
  HostRunContext,
  HostBatchRequest,
  HostRunResult,
} from './evalFrameworkTypes.js';
import type { MCPConfig } from '../config/mcpConfig.js';

/** Pre-execute a batch host, retaining per-case iteration queues for the evaluator. */
export async function prepareHostBatch(
  definition: HostDefinition,
  cases: EvalCase[],
  config: HostConfig,
  servers: MCPConfig[],
  context: HostRunContext
): Promise<Map<string, HostRunResult[]> | undefined> {
  if (!definition.runBatch) return undefined;
  const requests: HostBatchRequest[] = [];
  const queues = new Map<string, HostRunResult[]>();
  for (const c of cases) {
    if ((c.mode ?? 'direct') === 'direct') continue;
    if (c.mode === 'external_host')
      throw new Error(
        'Batch hosts require V2 host cases, not legacy external_host cases.'
      );
    if (queues.has(c.id))
      throw new Error('Batch host case IDs must be unique within a dataset.');
    const declaration = c.host ?? config;
    if (declaration.type !== config.type)
      throw new Error(
        'A batch host dataset cannot mix host types. Use separate manifests.'
      );
    queues.set(c.id, []);
    const iterations = c.iterations ?? context.manifest.iterations ?? 1;
    for (let iteration = 0; iteration < iterations; iteration++) {
      requests.push({
        caseId: c.id,
        iteration,
        config: declaration,
        input: { scenario: c.scenario ?? '', servers, env: context.env },
      });
    }
  }
  if (!requests.length) return queues;
  const traces = await definition.runBatch(requests, context);
  if (traces.length !== requests.length)
    throw new Error(
      'Batch host returned an incomplete trace set; refusing to resubmit.'
    );
  requests.forEach((request, index) =>
    queues.get(request.caseId)!.push(traces[index]!)
  );
  return queues;
}
