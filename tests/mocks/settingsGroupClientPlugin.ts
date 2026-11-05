import fs from 'node:fs/promises';
import { z } from 'zod';
import { ClientUnavailableError } from '../../src/evals/clientUnavailable.js';
import type { Plugin } from '../../src/plugins/plugin.js';

/** Fails once in the second settings group; a real resume can then finish it. */
export default {
  meta: { name: 'settings-group-test', namespace: 'settings-group' },
  clients: {
    session: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      async open({ config }) {
        const group = String(config.setting ?? config.model);
        const log = async (action: string) =>
          fs.appendFile(String(config.actionsFile), `${action}\n`);
        const failOnce = async () => {
          if (group !== 'b') return;
          const failed = await fs
            .readFile(String(config.failureMarker), 'utf8')
            .catch(() => '');
          if (failed) return;
          await fs.writeFile(String(config.failureMarker), 'failed');
          const message = 'second settings group unavailable';
          throw config.failure === 'open-unavailable'
            ? new ClientUnavailableError(message)
            : new Error(message);
        };
        await log(`open:${group}`);
        if (config.failure !== 'run-error') await failOnce();
        let closed = false;
        return {
          get lifecycle() {
            return { closed, group };
          },
          async run(trial) {
            await log(`run:${trial.caseId}:${trial.trial}`);
            if (config.failure === 'run-error') await failOnce();
            return {
              result: {
                finalText: `COMPLETED:${trial.caseId}:${trial.trial}`,
                events: [
                  {
                    kind: 'tool_call',
                    source: 'builtin',
                    name: 'example',
                    arguments: { caseId: trial.caseId, trial: trial.trial },
                    output: `answer:${trial.caseId}:${trial.trial}`,
                  },
                ],
                usage: { inputTokens: 5, outputTokens: 1, durationMs: 2 },
              },
              continuation: 'continue',
            };
          },
          async reset() {},
          async close() {
            closed = true;
            await log(`close:${group}`);
          },
        };
      },
    },
  },
} satisfies Plugin;
