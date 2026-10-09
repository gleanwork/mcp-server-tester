import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { collectInEnvironment, shardOf } from './shardedCollect.js';
import { SHARD_PROTOCOL } from './protocol.js';
import type { ResolvedEnvironment } from './builtinEnvironments.js';
import type { EvalConfig } from '../evalConfig.js';
import type { Environment } from '../evalFrameworkTypes.js';

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

async function collect(env: ResolvedEnvironment, caseIds: string[]) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-gather-'));
  dirs.push(workDir);
  return collectInEnvironment({
    environment: env,
    runId: 'run-1',
    evalConfig: { name: 'gather' } as EvalConfig,
    plugins: [],
    groups: [
      {
        variant: { name: 'baseline' },
        requests: caseIds.map((caseId) => ({
          caseId,
          trial: 0,
          config: { type: 'mst' },
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
