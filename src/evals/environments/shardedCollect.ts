/**
 * Collecting a run's trials in an environment (ADR 0004): split them into
 * shards by case, run the shards in parallel, and gather their results into
 * one set the run grades as it grades a batch's.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import type {
  ClientBatchRequest,
  ClientRunResult,
  ShardOutcome,
} from '../evalFrameworkTypes.js';
import type { EvalConfig, EvalVariant } from '../evalConfig.js';
import type { ResolvedEnvironment } from './builtinEnvironments.js';
import { createLimiter, trialResources, type RunLimits } from './limiter.js';
import {
  readClientResult,
  writeShardBundle,
  type TrialKey,
} from './protocol.js';

/** The shard a case runs on: every variant and trial of a case share one. */
export function shardOf(caseId: string, count: number): number {
  return createHash('sha256').update(caseId).digest().readUInt32BE(0) % count;
}

/** One variant's requests (of one client), as the worker runs them in a batch. */
export interface RequestGroup {
  variant: EvalVariant;
  requests: ClientBatchRequest[];
}

export interface CollectInEnvironmentOptions {
  environment: ResolvedEnvironment;
  runId: string;
  evalConfig: EvalConfig;
  /** Plugin specifiers the workers load. */
  plugins: string[];
  groups: RequestGroup[];
  /** The run's secrets, sent to each worker over its channel, never in a bundle. */
  secrets: Record<string, string>;
  /** A private local directory for bundles and copied results. */
  workDir: string;
  /** The most trials at once across every shard, per provider and server. */
  limits?: RunLimits;
  signal: AbortSignal;
  /** Each result as it comes back, before the shards end. */
  onResult?: (key: TrialKey, result: ClientRunResult) => Promise<void>;
  log?: (line: string) => void;
}

/** What the shards brought back. */
export interface GatheredResults {
  /** A trial's result; a trial whose shard ended without it is `missing`. */
  result(key: TrialKey): ClientRunResult;
  /** The trials with no result. */
  missing: TrialKey[];
  outcomes: ShardOutcome[];
}

const keyString = (key: TrialKey) =>
  JSON.stringify([key.variant, key.caseId, key.trial]);

/** Runs every group's requests in the environment, `environment.shards` at a time. */
export async function collectInEnvironment(
  options: CollectInEnvironmentOptions
): Promise<GatheredResults> {
  const { environment } = options;
  const count = environment.shards;
  const log = options.log ?? (() => {});
  const results = new Map<string, ClientRunResult>();
  const expected: TrialKey[] = options.groups.flatMap((group) =>
    group.requests.map((request) => ({
      variant: group.variant.name,
      caseId: request.caseId,
      trial: request.trial,
    }))
  );
  const opened = await environment.definition.open(environment.options, {
    runId: options.runId,
    shards: count,
    keep: environment.keep,
  });
  const reasons = new Map<number, string>();
  const outcomes: ShardOutcome[] = [];
  const limiter = createLimiter(options.limits);
  const resources = new Map<string, string[]>();
  for (const group of options.groups)
    for (const request of group.requests)
      resources.set(
        keyString({
          variant: group.variant.name,
          caseId: request.caseId,
          trial: request.trial,
        }),
        trialResources(request.config.model, request.input.servers)
      );
  try {
    const shards = Array.from({ length: count }, (_, index) => ({
      index,
      batches: options.groups
        .map((group) => ({
          variant: group.variant,
          requests: group.requests.filter(
            (request) => shardOf(request.caseId, count) === index
          ),
        }))
        .filter((batch) => batch.requests.length > 0),
    })).filter((shard) => shard.batches.length > 0);

    await Promise.all(
      shards.map(async ({ index, batches }) => {
        const root = path.join(options.workDir, `shard-${index}`);
        const bundleDir = path.join(root, 'bundle');
        const resultsDir = path.join(root, 'results');
        await writeShardBundle(bundleDir, {
          runId: options.runId,
          shard: { index, count },
          mst: packageJson.version,
          plugins: options.plugins,
          evalConfig: options.evalConfig,
          tokenServers: [],
          batches,
        });
        // Room this shard's trials hold under the limits, until they're done.
        const held = new Map<string, () => void>();
        const giveBack = (key: string) => {
          held.get(key)?.();
          held.delete(key);
        };
        // Results are read as they arrive, one at a time per shard, once each.
        let reading = Promise.resolve();
        const seen = new Set<string>();
        // A read that fails doesn't stop the ones after it.
        const read = (relative: string) =>
          (reading = reading
            .catch(() => {})
            .then(async () => {
              if (seen.has(relative)) return;
              // A copy can race the worker's next write; a file that isn't
              // here yet is read again after the shard's final copy.
              const file = await readClientResult(
                path.join(resultsDir, relative)
              );
              seen.add(relative);
              const result = file.result as unknown as ClientRunResult;
              results.set(keyString(file.key), result);
              await options.onResult?.(file.key, result);
            }));
        const outcome = await opened.runShard(
          {
            runId: options.runId,
            index,
            count,
            bundleDir,
            resultsDir,
          },
          {
            progress(event) {
              if (event.type === 'hello')
                log(
                  `shard ${index + 1}/${count}: ${event.client} on MST ${event.mst}${event.image ? ` (${event.image})` : ''}`
                );
              else if (event.type === 'trial') {
                giveBack(keyString(event.key));
                log(
                  `shard ${index + 1}/${count}: ${event.key.variant} ${event.key.caseId} #${event.key.trial + 1} ${event.status}`
                );
                read(event.path).catch(() => {});
              }
            },
            async requestTokens() {
              return { byServer: {}, env: options.secrets };
            },
            async acquire(key) {
              const id = keyString(key);
              held.set(id, await limiter.acquire(resources.get(id) ?? []));
            },
          },
          options.signal
        );
        // A shard that ended gives back whatever its trials still held.
        for (const key of [...held.keys()]) giveBack(key);
        await reading.catch(() => {});
        // Anything copied back that no progress event announced.
        for (const relative of await resultFiles(resultsDir))
          await read(relative).catch(() => {});
        await reading.catch(() => {});
        outcomes[index] = outcome;
        if (!outcome.ok)
          reasons.set(index, outcome.reason ?? 'it did not finish');
        log(
          `shard ${index + 1}/${count}: ${outcome.ok ? 'done' : `stopped: ${outcome.reason}`}`
        );
      })
    );
  } finally {
    await opened.close();
  }

  const missing = expected.filter((key) => !results.has(keyString(key)));
  return {
    result(key) {
      const found = results.get(keyString(key));
      if (found) return found;
      const shard = shardOf(key.caseId, count);
      return {
        finalText: '',
        events: [],
        error: `Missing: shard ${shard + 1} ended before this trial came back (${reasons.get(shard) ?? 'no result'}).`,
        diagnostics: { failureKind: 'missing' },
      };
    },
    missing,
    outcomes: outcomes.filter(Boolean),
  };
}

/**
 * A variant's gathered results as a batch's trial queues: each case's
 * trials in order, a missing trial in its place.
 */
export function gatheredQueues(
  gathered: GatheredResults,
  variant: string,
  requests: readonly ClientBatchRequest[]
): Map<string, ClientRunResult[]> {
  const queues = new Map<string, ClientRunResult[]>();
  for (const request of requests) {
    const queue = queues.get(request.caseId) ?? [];
    queue.push(
      gathered.result({ variant, caseId: request.caseId, trial: request.trial })
    );
    queues.set(request.caseId, queue);
  }
  return queues;
}

/** `<batch>/<index>.json` files under `dir`. */
async function resultFiles(dir: string): Promise<string[]> {
  const entries = await fs
    .readdir(dir, { recursive: true })
    .catch(() => [] as string[]);
  return entries
    .map(String)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'));
}
