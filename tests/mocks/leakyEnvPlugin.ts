/**
 * An environment, `leaky/env/unredacted`, whose "worker" writes every trial's
 * result itself and redacts nothing: it quotes the secrets file's
 * `ACME_API_KEY` in the answer and the error. A run must still store no
 * secret, because the coordinator redacts what it receives.
 *
 * When `LEAKY_SNAPSHOT_DIR` is set, the text of every file under it, read
 * once the shard's trials are reported and before the run grades them, is
 * left in `globalThis[Symbol.for('leaky-env-plugin.snapshot')]`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  readShardBundle,
  SHARD_PROTOCOL,
} from '../../src/evals/environments/protocol.js';
import type { Plugin } from '../../src/plugins/plugin.js';

async function allText(dir: string): Promise<string> {
  const entries = await fs
    .readdir(dir, { recursive: true, withFileTypes: true })
    .catch(() => []);
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')
      )
  );
  return texts.join('\n');
}

export default {
  meta: { name: 'leaky-env-plugin', namespace: 'leaky' },
  environments: {
    unredacted: {
      schema: z.object({}).strict(),
      maxShards: 1,
      async open() {
        return {
          async runShard(shard, events) {
            const bundle = await readShardBundle(shard.bundleDir);
            const tokens = await events.requestTokens({
              servers: bundle.tokenServers,
              reason: 'start',
            });
            const leaked = tokens.env?.ACME_API_KEY ?? 'none';
            let collected = 0;
            for (const [
              batch,
              { variant, requests },
            ] of bundle.batches.entries())
              for (const [index, request] of requests.entries()) {
                const key = {
                  variant: variant.name,
                  caseId: request.caseId,
                  trial: request.trial,
                };
                const relative = `${batch}/${index}.json`;
                const file = path.join(shard.resultsDir, relative);
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(
                  file,
                  JSON.stringify({
                    format: SHARD_PROTOCOL,
                    kind: 'client-result',
                    key,
                    result: {
                      finalText: `the key is ${leaked}`,
                      events: [],
                      error: `failed with ${leaked}`,
                    },
                  })
                );
                collected++;
                events.progress({
                  type: 'trial',
                  key,
                  status: 'collected',
                  path: relative,
                });
              }
            const snapshotDir = process.env.LEAKY_SNAPSHOT_DIR;
            if (snapshotDir) {
              // The coordinator saves each trial as it is reported.
              await new Promise((resolve) => setTimeout(resolve, 200));
              (globalThis as Record<symbol, unknown>)[
                Symbol.for('leaky-env-plugin.snapshot')
              ] = await allText(snapshotDir);
            }
            return { ok: true, collected, infra: 0, cancelled: false };
          },
          async close() {},
        };
      },
    },
  },
} satisfies Plugin;
