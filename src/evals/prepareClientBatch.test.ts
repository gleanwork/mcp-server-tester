import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ClientRunResult } from './evalFrameworkTypes.js';
import { prepareClientBatch } from './prepareClientBatch.js';

describe('prepareClientBatch redaction', () => {
  const evalConfig = { name: 'm', datasets: [] };
  const envSecret = 'env-secret-value';
  const fileSecret = 'file-secret-value';

  it('redacts every transcript a batch client hands MST, early or at the end', async () => {
    const early: ClientRunResult[] = [];
    // Like a run's connector tokens: every token delivered so far.
    const delivered = ['token-before-renewal'];
    const transcriptWith = (secret: string): ClientRunResult => ({
      finalText: `answer with ${secret}`,
      events: [],
      telemetry: { content: { history: [`said ${secret}`] } },
      artifacts: { dir: `/tmp/${secret}`, include: ['**'] },
    });
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        async open() {
          let index = 0;
          return {
            async run() {
              // The token renews between trials of the open session.
              const result =
                index++ === 0
                  ? transcriptWith(`${envSecret} token-before-renewal`)
                  : transcriptWith(`${fileSecret} token-after-renewal`);
              delivered.push('token-after-renewal');
              return { result, continuation: 'continue' };
            },
            async reset() {},
            async close() {},
          };
        },
      },
      [{ id: 'a', input: 'x', trials: 2 }],
      { type: 'test/batch' },
      [],
      { evalConfig, env: { ACME_API_KEY: envSecret } },
      undefined,
      {
        secrets: () => [fileSecret, ...delivered],
        onTranscript: async (_request, transcript) => {
          early.push(transcript);
        },
      }
    );
    const stored = [...early, ...(queues?.get('a') ?? [])];
    expect(stored).toHaveLength(4);
    const text = JSON.stringify(
      stored.map(({ artifacts: _, ...rest }) => rest)
    );
    for (const secret of [
      envSecret,
      fileSecret,
      'token-before-renewal',
      'token-after-renewal',
    ])
      expect(text).not.toContain(secret);
    expect(early[0]?.finalText).toBe('answer with [REDACTED] [REDACTED]');
    // Artifacts are paths to files on this machine, kept as they are.
    expect(queues?.get('a')?.[1]?.artifacts?.dir).toBe(
      `/tmp/${fileSecret} token-after-renewal`
    );
  });
});
