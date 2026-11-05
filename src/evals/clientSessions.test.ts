import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { collectClientBatch } from './desktopBatch.js';
import { prepareClientBatch } from './prepareClientBatch.js';
import type {
  ClientBatchRequest,
  ClientDefinition,
  ClientSession,
} from './evalFrameworkTypes.js';

const context = { evalConfig: { name: 'sessions', datasets: [] } };

function requests(count = 3): ClientBatchRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    config: { type: 'acme/client/session', model: 'model-a' },
    caseId: index === 1 ? 'one' : `case-${index}`,
    trial: index,
    input: { prompt: `prompt ${index}`, servers: [], env: { SETTING: 'a' } },
  }));
}

function session(overrides: Partial<ClientSession> = {}): ClientSession {
  const base: ClientSession = {
    async run(trial) {
      return {
        result: {
          finalText: trial.input.prompt,
          events: [],
          usage: { inputTokens: 7, outputTokens: 1, durationMs: 2 },
        },
        continuation: 'continue',
      };
    },
    async reset() {},
    async close() {},
  };
  return Object.defineProperties(
    base,
    Object.getOwnPropertyDescriptors(overrides)
  );
}

function definition(
  open: NonNullable<ClientDefinition['open']>
): ClientDefinition {
  return { schema: z.object({}).passthrough(), open };
}

afterEach(() => vi.useRealTimers());

describe('client session collection', () => {
  it('prefers open over run and keeps identity, prompts, usage and original report indices', async () => {
    const seen: unknown[] = [];
    const reports: unknown[] = [];
    const run = vi.fn();
    const open = vi.fn(async () =>
      session({
        async run(trial) {
          seen.push(trial);
          return {
            result: {
              finalText: trial.input.prompt,
              events: [],
              usage: { inputTokens: 7, outputTokens: 1, durationMs: 2 },
            },
            continuation: 'continue',
          };
        },
      })
    );
    const batch = requests();
    const results = await collectClientBatch(
      { ...definition(open), run },
      batch,
      {
        ...context,
        reportResult: async (index, result) => {
          reports.push([index, result.finalText]);
        },
      }
    );
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]).toEqual([
      {
        config: batch[0]!.config,
        input: { servers: [], env: { SETTING: 'a' } },
      },
      expect.anything(),
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(seen).toEqual(
      batch.map(({ caseId, trial, input }) => ({
        caseId,
        trial,
        input: { prompt: input.prompt },
      }))
    );
    expect(reports).toEqual([
      [0, 'prompt 0'],
      [1, 'prompt 1'],
      [2, 'prompt 2'],
    ]);
    expect(results.map((result) => result.usage)).toEqual(
      Array(3).fill({ inputTokens: 7, outputTokens: 1, durationMs: 2 })
    );
    expect(results[0]).not.toHaveProperty('telemetry');
  });

  it.each(['model', 'options', 'servers', 'environment'] as const)(
    'opens separate sessions for different fixed %s',
    async (field) => {
      const batch = requests();
      if (field === 'model') batch[1]!.config.model = 'model-b';
      if (field === 'options') batch[1]!.config.setting = 'b';
      if (field === 'servers')
        batch[1]!.input.servers = [
          { transport: 'http', serverUrl: 'https://example.test/mcp' },
        ];
      if (field === 'environment') batch[1]!.input.env = { SETTING: 'b' };
      const open = vi.fn(async () => session());
      const reported: number[] = [];
      const results = await collectClientBatch(definition(open), batch, {
        ...context,
        reportResult: async (index) => {
          reported.push(index);
        },
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(reported).toEqual([0, 2, 1]);
      expect(results.map((result) => result.finalText)).toEqual([
        'prompt 0',
        'prompt 1',
        'prompt 2',
      ]);
    }
  );

  it('keeps local run-only clients on their concurrent per-case path', async () => {
    const run = vi.fn();
    expect(
      await prepareClientBatch(
        { schema: z.object({}), run },
        [{ id: 'one', input: 'one' }],
        { type: 'acme/client/one-shot' },
        [],
        context
      )
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('redacts failed opens and preserves secret-free setup error identities', async () => {
    const original = Object.assign(new Error('setup failed'), {
      code: 'SETUP',
    });
    await expect(
      collectClientBatch(
        definition(async () => {
          throw original;
        }),
        requests(),
        context
      )
    ).rejects.toBe(original);
    const failed = collectClientBatch(
      definition(async () => {
        throw new Error('setup failed secret-value');
      }),
      requests(),
      context,
      ['secret-value']
    );
    await expect(failed).rejects.toThrow('setup failed [REDACTED]');
  });

  it('closes on cancellation between fixed-settings groups and leaves unsent indices missing', async () => {
    const batch = requests();
    batch[1]!.config.model = 'different';
    let cancelled = false;
    let reported = 0;
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => session({ close }));
    const results = await collectClientBatch(
      definition(open),
      batch,
      {
        ...context,
        reportResult: async () => {
          if (++reported === 2) cancelled = true;
        },
      },
      [],
      () => cancelled
    );
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(results[0]?.finalText).toBe('prompt 0');
    expect(results[1]).toBeUndefined();
    expect(results[2]?.finalText).toBe('prompt 2');
  });

  it('wraps worker run-only calls without stopping later trials or changing thrown endings', async () => {
    const run = vi
      .fn<NonNullable<ClientDefinition['run']>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
      )
      .mockResolvedValue({ finalText: 'ok', events: [] });
    const results = await collectClientBatch(
      { schema: z.object({}), run },
      requests(),
      context
    );
    expect(run).toHaveBeenCalledTimes(3);
    expect(results[0]!.ending).toMatchObject({
      kind: 'infrastructure',
      broke: 'network',
    });
    expect(results.slice(1).map((result) => result.finalText)).toEqual([
      'ok',
      'ok',
    ]);
  });

  it('diagnoses before reset, waits for room, reports, and closes in one loop', async () => {
    const order: string[] = [];
    let index = 0;
    const results = await collectClientBatch(
      definition(async () =>
        session({
          async run() {
            order.push('run');
            return index++ === 0
              ? {
                  result: { finalText: '', events: [], error: 'failed' },
                  continuation: 'reset',
                }
              : {
                  result: { finalText: 'ok', events: [] },
                  continuation: 'continue',
                };
          },
          async diagnose() {
            order.push('diagnose');
            return undefined;
          },
          async reset() {
            order.push('reset');
          },
          async close() {
            order.push('close');
          },
        })
      ),
      requests(2),
      {
        ...context,
        acquire: async () => {
          order.push('acquire');
        },
        reportResult: async () => {
          order.push('report');
        },
      }
    );
    expect(order).toEqual([
      'acquire',
      'run',
      'diagnose',
      'report',
      'reset',
      'acquire',
      'run',
      'report',
      'close',
    ]);
    expect(results).toHaveLength(2);
  });

  it('keeps earlier results when a session throws and never submits later trials', async () => {
    let index = 0;
    const close = vi.fn(async () => {});
    const diagnose = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      if (index++) throw new Error('client disappeared secret-value');
      return {
        result: { finalText: 'first', events: [] },
        continuation: 'continue' as const,
      };
    });
    const results = await collectClientBatch(
      definition(async () => session({ run, close, diagnose })),
      requests(4),
      context,
      ['secret-value']
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(results[0]!.finalText).toBe('first');
    expect(results[1]!.diagnostics?.failureKind).toBe('process');
    expect(
      results.slice(2).map((result) => result.diagnostics?.failureKind)
    ).toEqual(['not-submitted', 'not-submitted']);
    expect(JSON.stringify(results)).not.toContain('secret-value');
  });

  it.each(['acquire', 'reportResult'] as const)(
    'closes when %s throws',
    async (callback) => {
      const close = vi.fn(async () => {});
      const operation = collectClientBatch(
        definition(async () => session({ close })),
        requests(),
        {
          ...context,
          [callback]: async () => {
            throw new Error('callback failed');
          },
        }
      );
      if (callback === 'acquire')
        await expect(operation).rejects.toThrow('callback failed');
      else expect(await operation).toHaveLength(3);
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it('closes after failed post-open readiness without running a trial', async () => {
    const close = vi.fn(async () => {});
    const run = vi.fn();
    await expect(
      collectClientBatch(
        definition(async () =>
          session({
            close,
            run,
            readiness: {
              servers: [
                { transport: 'http', serverUrl: 'https://example.test/mcp' },
              ],
              env: { MST_MCP_READINESS_RETRY_S: 'invalid' },
            },
          })
        ),
        requests(),
        context
      )
    ).rejects.toThrow('MST_MCP_READINESS_RETRY_S');
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks all results when close fails and reads lifecycle after close', async () => {
    let closed = false;
    const results = await collectClientBatch(
      definition(async () =>
        session({
          get lifecycle() {
            return { closed };
          },
          async close() {
            closed = true;
            throw new Error('cleanup secret-value');
          },
        })
      ),
      requests(),
      context,
      ['secret-value']
    );
    for (const result of results) {
      expect(result.diagnostics?.failureKind).toBe('cleanup');
      expect(result.telemetry?.batchLifecycle).toEqual({ closed: true });
      expect(result.error).toBe('cleanup [REDACTED]');
    }
  });

  it('does not submit after stop or a failed reset', async () => {
    for (const continuation of ['stop', 'reset'] as const) {
      const run = vi.fn(async () => ({
        result: { finalText: '', events: [] },
        continuation,
      }));
      const reset = vi.fn(async () => {
        throw new Error('reset failed');
      });
      const results = await collectClientBatch(
        definition(async () => session({ run, reset })),
        requests(),
        context
      );
      expect(run).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenCalledTimes(continuation === 'reset' ? 1 : 0);
      expect(
        results
          .slice(1)
          .every(
            (result) => result.diagnostics?.failureKind === 'not-submitted'
          )
      ).toBe(true);
    }
  });

  it('bounds plugin diagnosis at the existing 30-second deadline and treats it as best effort', async () => {
    vi.useFakeTimers();
    let index = 0;
    const close = vi.fn(async () => {});
    const operation = collectClientBatch(
      definition(async () =>
        session({
          async run() {
            return {
              result: {
                finalText: '',
                events: [],
                ...(index++ === 0 ? { error: 'failed' } : {}),
              },
              continuation: 'reset',
            };
          },
          async diagnose() {
            return new Promise(() => {});
          },
          close,
        })
      ),
      requests(2),
      context
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await operation).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
