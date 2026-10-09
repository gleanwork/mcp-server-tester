/**
 * The fork environment as a plugin, `fork/env/children`, for runs through
 * `runEval` and the CLI. `--env-option fail=<n>` loses shard n's machine.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { forkEnvironment } from './forkEnvironment.js';
import type { Plugin } from '../../src/plugins/plugin.js';

export default {
  meta: { name: 'fork-env-plugin', namespace: 'fork' },
  environments: {
    children: {
      schema: z.object({ fail: z.coerce.number().optional() }).strict(),
      maxShards: 8,
      async open(options, context) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-fork-env-'));
        const environment = forkEnvironment(
          context,
          root,
          {},
          {
            ...(typeof options.fail === 'number'
              ? { failShard: options.fail }
              : {}),
          }
        );
        return {
          runShard: environment.runShard.bind(environment),
          async close() {
            await environment.close();
            await fs.rm(root, { recursive: true, force: true });
          },
        };
      },
    },
  },
} satisfies Plugin;
