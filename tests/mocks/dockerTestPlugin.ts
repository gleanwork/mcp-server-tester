/**
 * A client for tests of the `docker` environment, loaded by `mst collect`
 * in a fake container. It answers each case, and leaves an artifact in a
 * folder in the container's home, as Cowork leaves its session folder.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ClientRunResult } from '../../src/evals/evalFrameworkTypes.js';
import type { Plugin } from '../../src/plugins/plugin.js';

export default {
  meta: { name: 'docker-test-plugin', namespace: 'dt' },
  clients: {
    notes: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      async run(input): Promise<ClientRunResult> {
        // In the container (HOME), which is removed before grading.
        const dir = await fs.mkdtemp(path.join(os.homedir(), 'dt-session-'));
        await fs.writeFile(path.join(dir, 'audit.jsonl'), `${input.prompt}\n`);
        return {
          finalText: `answered: ${input.prompt}`,
          events: [],
          artifacts: { dir, include: ['**'] },
        };
      },
    },
  },
} satisfies Plugin;
