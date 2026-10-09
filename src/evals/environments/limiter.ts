/**
 * Run-wide limits on concurrent trials across an environment's shards
 * (ADR 0004): N desktops share one LLM gateway and the same vendor servers.
 */
import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import { providerForModel } from '../builtinClients.js';

/** An eval config's `limits`: the most trials at once, by provider and server. */
export interface RunLimits {
  providers?: Record<string, number>;
  servers?: Record<string, number>;
}

/** What a trial holds while it runs: its model's provider, and its servers. */
export function trialResources(
  model: unknown,
  servers: readonly MCPConfig[]
): string[] {
  const provider =
    typeof model === 'string' ? providerForModel(model) : undefined;
  return [
    ...(provider ? [`provider:${provider}`] : []),
    ...servers.map(
      (server, index) => `server:${mcpServerLabel(server, index)}`
    ),
  ];
}

/**
 * Grants trials their resources within the limits: at once when they have
 * room, otherwise in arrival order as room frees up.
 */
export interface Limiter {
  /** Waits until every capped resource has room; resolves to its release. */
  acquire(resources: readonly string[]): Promise<() => void>;
}

export function createLimiter(limits: RunLimits | undefined): Limiter {
  const caps = new Map<string, number>([
    ...Object.entries(limits?.providers ?? {}).map(
      ([name, cap]) => [`provider:${name}`, cap] as const
    ),
    ...Object.entries(limits?.servers ?? {}).map(
      ([name, cap]) => [`server:${name}`, cap] as const
    ),
  ]);
  const inUse = new Map<string, number>();
  const waiting: Array<{
    resources: string[];
    grant: (release: () => void) => void;
  }> = [];
  const fits = (resources: readonly string[]) =>
    resources.every(
      (resource) =>
        (inUse.get(resource) ?? 0) < (caps.get(resource) ?? Infinity)
    );
  const take = (resources: string[]) => {
    for (const resource of resources)
      inUse.set(resource, (inUse.get(resource) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const resource of resources)
        inUse.set(resource, (inUse.get(resource) ?? 1) - 1);
      // In arrival order; a waiter that fits doesn't wait behind one that doesn't.
      for (let index = 0; index < waiting.length; ) {
        const next = waiting[index]!;
        if (fits(next.resources)) {
          waiting.splice(index, 1);
          next.grant(take(next.resources));
        } else index++;
      }
    };
  };
  return {
    async acquire(resources) {
      const capped = resources.filter((resource) => caps.has(resource));
      // Like a release: a trial with room starts, even with others waiting.
      if (fits(capped)) return take(capped);
      return new Promise((grant) => waiting.push({ resources: capped, grant }));
    },
  };
}
