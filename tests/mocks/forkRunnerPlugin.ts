/**
 * The fork runner as a plugin, `fork/runner/children`, for runs through
 * `runEval` and the CLI. `--runner-option fail=<n>` loses shard n's machine;
 * `throw=<n>` makes `runShard` reject for shard n, as a runner that
 * breaks its contract does; `workerEnv=<JSON object>` sets variables in the
 * workers' environment only.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { forkRunner } from './forkRunner.js';
import type { Plugin } from '../../src/plugins/plugin.js';

export default {
  meta: { name: 'fork-runner-plugin', namespace: 'fork' },
  runners: {
    children: {
      schema: z
        .object({
          fail: z.coerce.number().optional(),
          throw: z.coerce.number().optional(),
          workerEnv: z.string().optional(),
        })
        .strict(),
      maxShards: 8,
      async open(options, context) {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), 'mst-fork-runner-')
        );
        const runner = forkRunner(
          context,
          root,
          typeof options.workerEnv === 'string'
            ? z
                .record(z.string(), z.string())
                .parse(JSON.parse(options.workerEnv))
            : {},
          {
            ...(typeof options.fail === 'number'
              ? { failShard: options.fail }
              : {}),
          }
        );
        return {
          // Whatever work its machines' channel runs: collect and grade.
          work: runner.work,
          async runShard(shard, events, signal) {
            if (shard.index === options.throw)
              throw new Error(`the runner threw for shard ${shard.index + 1}`);
            return runner.runShard(shard, events, signal);
          },
          async close() {
            await runner.close();
            await fs.rm(root, { recursive: true, force: true });
          },
        };
      },
    },
  },
} satisfies Plugin;
