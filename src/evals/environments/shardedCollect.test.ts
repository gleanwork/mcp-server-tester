import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  collectInEnvironment,
  requestGroups,
  shardOf,
} from './shardedCollect.js';
import { SHARD_PROTOCOL } from './protocol.js';
import type { ResolvedEnvironment } from './builtinEnvironments.js';
import type { EvalConfig } from '../evalConfig.js';
import type { Environment } from '../evalFrameworkTypes.js';
import type { CollectInEnvironmentOptions } from './shardedCollect.js';

describe('requestGroups', () => {
  const request = (caseId: string, config: Record<string, unknown>) => ({
    caseId,
    trial: 0,
    input: {} as never,
    config: { type: 'cowork', ...config },
  });

  it('puts requests with different client settings in different batches', () => {
    const variant = { name: 'v' };
    const groups = requestGroups(variant, [
      request('a', { model: 'm' }),
      request('b', { model: 'm', timeout: 1000 }),
      request('c', { model: 'm' }),
      { ...request('d', {}), config: { type: 'api', model: 'm' } },
      // The same settings as b, written in another order.
      {
        ...request('e', {}),
        config: { timeout: 1000, model: 'm', type: 'cowork' },
      },
    ]);
    expect(groups.map((group) => group.requests.map((r) => r.caseId))).toEqual([
      ['a', 'c'],
      ['b', 'e'],
      ['d'],
    ]);
    expect(groups.every((group) => group.variant === variant)).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

function environment(
  runShard: Environment['runShard'],
  shards = 1
): ResolvedEnvironment {
  return {
    name: 'test/env/fake',
    shards,
    keep: 'never',
    options: {},
    definition: {
      schema: z.object({}),
      async open() {
        return { runShard, async close() {} };
      },
    },
  };
}

async function collect(
  env: ResolvedEnvironment,
  caseIds: string[],
  onResult?: CollectInEnvironmentOptions['onResult']
) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-gather-'));
  dirs.push(workDir);
  return collectInEnvironment({
    environment: env,
    runId: 'run-1',
    evalConfig: { name: 'gather' } as EvalConfig,
    plugins: [],
    onResult,
    groups: [
      {
        variant: { name: 'baseline' },
        requests: caseIds.map((caseId) => ({
          caseId,
          trial: 0,
          config: { type: 'api' },
          input: { prompt: caseId, servers: [] },
        })),
      },
    ],
    secrets: {},
    workDir,
    signal: new AbortController().signal,
  });
}

const ok = { ok: true, collected: 1, infra: 0, cancelled: false };

describe('shardOf', () => {
  it('puts a case on the same shard every time, within range', () => {
    for (const id of ['a', 'e2e-0011', 'case with spaces'])
      for (const count of [1, 2, 5]) {
        const shard = shardOf(id, count);
        expect(shard).toBe(shardOf(id, count));
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(count);
      }
  });
});

describe('collectInEnvironment', () => {
  it("opens the environment with the eval's client, so it can pick that client's image", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-gather-'));
    dirs.push(workDir);
    let client: string | undefined;
    const env = environment(async () => ok);
    const open = env.definition.open;
    env.definition.open = async (options, context) => {
      client = context.client;
      return open(options, context);
    };
    await collectInEnvironment({
      environment: env,
      runId: 'run-1',
      evalConfig: { name: 'gather', client: 'chatgpt' } as EvalConfig,
      plugins: [],
      groups: [],
      secrets: {},
      workDir,
      signal: new AbortController().signal,
    });
    expect(client).toBe('chatgpt');
  });

  it("records the OS each shard's worker ran on, not the coordinator's", async () => {
    const gathered = await collect(
      environment(async (_shard, events) => {
        events.progress({
          type: 'hello',
          mst: '9.9.9',
          platform: process.platform === 'linux' ? 'darwin' : 'linux',
          client: 'cowork',
        });
        return { ...ok, collected: 0 };
      }),
      ['a']
    );
    expect(gathered.shards).toEqual([
      {
        shard: 1,
        mst: '9.9.9',
        platform: process.platform === 'linux' ? 'darwin' : 'linux',
        client: 'cowork',
        ok: true,
        collected: 0,
      },
    ]);
  });

  it('contains an environment that throws to its shard: the other shards finish, keep their results, and close once', async () => {
    // 'a' hashes to shard 1, 'c' to shard 2 (shardOf).
    const order: string[] = [];
    let releaseHealthy!: () => void;
    const healthyMayFinish = new Promise<void>((resolve) => {
      releaseHealthy = resolve;
    });
    const env = environment(async (shard, events) => {
      if (shard.index === 0) {
        order.push('shard-1 threw');
        // Let the healthy sibling finish only after the throw has propagated.
        setTimeout(releaseHealthy, 20);
        throw new Error('the machine API returned 503');
      }
      await healthyMayFinish;
      await fs.mkdir(path.join(shard.resultsDir, '0'), { recursive: true });
      await fs.writeFile(
        path.join(shard.resultsDir, '0/0.json'),
        JSON.stringify({
          format: SHARD_PROTOCOL,
          kind: 'client-result',
          key: { variant: 'baseline', caseId: 'c', trial: 0 },
          result: { finalText: 'from the healthy shard', events: [] },
        })
      );
      events.progress({
        type: 'trial',
        key: { variant: 'baseline', caseId: 'c', trial: 0 },
        status: 'collected',
        path: '0/0.json',
      });
      order.push('shard-2 finished');
      return ok;
    }, 2);
    const open = env.definition.open;
    env.definition.open = async (options, context) => {
      const opened = await open(options, context);
      return {
        ...opened,
        async close() {
          order.push('closed');
        },
      };
    };
    const gathered = await collect(env, ['a', 'c']);
    expect(order).toEqual(['shard-1 threw', 'shard-2 finished', 'closed']);
    expect(gathered.outcomes[0]).toEqual({
      ok: false,
      reason: 'The environment failed shard 1: the machine API returned 503',
      collected: 0,
      infra: 0,
      cancelled: false,
    });
    expect(gathered.outcomes[1]).toEqual(ok);
    expect(
      gathered.result({ variant: 'baseline', caseId: 'c', trial: 0 })
    ).toMatchObject({ finalText: 'from the healthy shard' });
    expect(gathered.missing).toEqual([
      { variant: 'baseline', caseId: 'a', trial: 0 },
    ]);
    expect(
      gathered.result({ variant: 'baseline', caseId: 'a', trial: 0 }).error
    ).toContain('the machine API returned 503');
  });

  it('finds a result announced before its file was copied back', async () => {
    const gathered = await collect(
      environment(async (shard, events) => {
        // Announced first; the file only lands with the final copy.
        events.progress({
          type: 'trial',
          key: { variant: 'baseline', caseId: 'a', trial: 0 },
          status: 'collected',
          path: '0/0.json',
        });
        await fs.mkdir(path.join(shard.resultsDir, '0'), { recursive: true });
        await fs.writeFile(
          path.join(shard.resultsDir, '0/0.json'),
          JSON.stringify({
            format: SHARD_PROTOCOL,
            kind: 'client-result',
            key: { variant: 'baseline', caseId: 'a', trial: 0 },
            result: { finalText: 'from the worker', events: [] },
          })
        );
        return ok;
      }),
      ['a']
    );
    expect(gathered.missing).toEqual([]);
    expect(
      gathered.result({ variant: 'baseline', caseId: 'a', trial: 0 })
    ).toMatchObject({ finalText: 'from the worker' });
  });

  it('replaces an early result with cleanup facts in the final worker copy', async () => {
    let resolveEarly!: () => void;
    const early = new Promise<void>((resolve) => {
      resolveEarly = resolve;
    });
    const errors: Array<string | undefined> = [];
    const key = { variant: 'baseline', caseId: 'a', trial: 0 };
    const gathered = await collect(
      environment(async (shard, events) => {
        const file = path.join(shard.resultsDir, '0/0.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        const initial = {
          format: SHARD_PROTOCOL,
          kind: 'client-result',
          key,
          result: { finalText: 'answer', events: [] },
        };
        await fs.writeFile(file, JSON.stringify(initial));
        events.progress({
          type: 'trial',
          key,
          status: 'collected',
          path: '0/0.json',
        });
        await early;
        await fs.writeFile(
          file,
          JSON.stringify({
            ...initial,
            result: {
              ...initial.result,
              error: 'cleanup failed',
              diagnostics: { failureKind: 'cleanup' },
              telemetry: { batchLifecycle: { closed: true } },
            },
          })
        );
        return { ...ok, collected: 0, infra: 1 };
      }),
      ['a'],
      async (_key, result) => {
        errors.push(result.error);
        resolveEarly();
      }
    );
    expect(errors).toEqual([undefined, 'cleanup failed']);
    expect(gathered.result(key)).toMatchObject({
      error: 'cleanup failed',
      diagnostics: { failureKind: 'cleanup' },
      telemetry: { batchLifecycle: { closed: true } },
    });
  });

  it("marks a failed shard's trials missing, with why", async () => {
    const gathered = await collect(
      environment(async () => ({
        ok: false,
        reason: 'the VM was preempted',
        collected: 0,
        infra: 0,
        cancelled: false,
      })),
      ['a']
    );
    const key = { variant: 'baseline', caseId: 'a', trial: 0 };
    expect(gathered.missing).toEqual([key]);
    expect(gathered.result(key)).toEqual({
      finalText: '',
      events: [],
      error:
        'Missing: shard 1 ended before this trial came back (the VM was preempted).',
      diagnostics: { failureKind: 'missing' },
    });
  });
});
