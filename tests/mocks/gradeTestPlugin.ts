/**
 * Judges for grade shards (ADR 0005), as a plugin file workers load:
 * `grade-test/judge/where` passes when the answer says "then", and reports
 * the process it ran in and whether it could read its key; its preflight
 * needs `GRADE_TEST_KEY`, which reaches a worker only from the secrets
 * file. `grade-test/pairwise-judge/longer` prefers the longer answer, from
 * the process it ran in. `grade-test/env/collect-only` runs collect shards,
 * not grade shards.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { forkEnvironment } from './forkEnvironment.js';
import type { Plugin } from '../../src/plugins/plugin.js';

const KEY = 'GRADE_TEST_KEY';

export default {
  meta: { name: 'grade-test-plugin', namespace: 'grade-test' },
  judges: {
    where: {
      schema: z.object({}).passthrough(),
      async preflight() {
        if (!process.env[KEY]) throw new Error(`${KEY} isn't set.`);
      },
      async evaluate({ trial }: { trial: { text?: string } }) {
        return {
          score: trial.text?.includes('then') ? 1 : 0,
          // The key itself, as a careless judge might echo it.
          reasoning: `pid ${process.pid}; key ${process.env[KEY] ?? 'unset'}`,
        };
      },
    },
  },
  pairwiseJudges: {
    longer: {
      schema: z.object({}).strict(),
      async compare({
        baseline,
        candidate,
      }: {
        baseline: { text?: string };
        candidate: { text?: string };
      }) {
        return {
          preference:
            (candidate.text?.length ?? 0) > (baseline.text?.length ?? 0)
              ? ('candidate' as const)
              : ('tie' as const),
          reasoning: `pid ${process.pid}`,
        };
      },
    },
  },
  environments: {
    'collect-only': {
      schema: z.object({}).strict(),
      async open(_options, context) {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), 'mst-collect-only-')
        );
        const environment = forkEnvironment(context, root, {});
        // A wrapper that doesn't pass `work` on runs collect shards only.
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
