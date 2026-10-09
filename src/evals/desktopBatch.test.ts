import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  requireIdenticalClientSettings,
  runDesktopBatch,
  type DesktopCaseOutcome,
  type DesktopClientAdapter,
} from './desktopBatch.js';
import type {
  ClientBatchRequest,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import { McpReadinessError } from './mcpReadiness.js';
import { ClientUnavailableError } from './clientUnavailable.js';

const SECRET = 'sk-desktop-secret';
let leaseDirectory = '';

beforeEach(async () => {
  leaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-lease-'));
});
afterEach(async () => {
  await fs.rm(leaseDirectory, { recursive: true, force: true });
});

function requests(count: number): ClientBatchRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `case-${index + 1}`,
    trial: 0,
    input: { prompt: `prompt ${index + 1}`, servers: [] },
    config: { type: 'fake' },
  })) as ClientBatchRequest[];
}

const ok = (text: string): DesktopCaseOutcome => ({
  result: { finalText: text, events: [] },
  continuation: 'allowed',
});

/** A fake desktop client that records its lifecycle. */
function fakeClient(
  overrides: Partial<DesktopClientAdapter<{ id: string }>> = {}
): DesktopClientAdapter<{ id: string }> & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    name: 'Fake',
    lease: { directory: leaseDirectory, file: 'fake-desktop.lock' },
    secrets: [SECRET],
    resetVerb: 'reset',
    async prepare() {
      events.push('prepare');
      return { id: 'session' };
    },
    async runCase(_session, request, index) {
      events.push(`case ${index + 1}`);
      return ok(request.caseId);
    },
    async reset(_session, index) {
      events.push(`reset before ${index + 1}`);
    },
    async dispose(session) {
      events.push(`dispose ${session?.id ?? 'none'}`);
    },
    ...overrides,
  };
}

const leasePath = () => path.join(leaseDirectory, 'fake-desktop.lock');
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false
  );

describe('runDesktopBatch', () => {
  it('prepares, runs every case, disposes and releases the lease', async () => {
    const client = fakeClient();
    const results = await runDesktopBatch(client, requests(2));
    expect(results.map((result) => result.finalText)).toEqual([
      'case-1',
      'case-2',
    ]);
    expect(client.events).toEqual([
      'prepare',
      'case 1',
      'case 2',
      'dispose session',
    ]);
    expect(results[1]?.telemetry?.batchCase).toEqual({
      index: 1,
      caseId: 'case-2',
      count: 2,
    });
    expect(await exists(leasePath())).toBe(false);
  });

  it('does nothing for an empty batch', async () => {
    const client = fakeClient();
    expect(await runDesktopBatch(client, [])).toEqual([]);
    expect(client.events).toEqual([]);
  });

  it('refuses a second batch while the desktop is leased', async () => {
    let release: () => void = () => {};
    const first = runDesktopBatch(
      fakeClient({
        async prepare() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { id: 'first' };
        },
      }),
      requests(1)
    );
    await vi.waitFor(async () => expect(await exists(leasePath())).toBe(true));
    const lease = JSON.parse(await fs.readFile(leasePath(), 'utf8')) as {
      pid: number;
    };
    expect(lease.pid).toBe(process.pid);
    const refused = runDesktopBatch(fakeClient(), requests(1));
    await expect(refused).rejects.toThrow(
      'Fake desktop is locked by another run or an interrupted run'
    );
    // The eval records the batch as unavailable and goes on.
    await expect(refused).rejects.toBeInstanceOf(ClientUnavailableError);
    release();
    await first;
  });

  it('resets after a case that left the app unknown', async () => {
    const client = fakeClient({
      async runCase(_session, request, index) {
        client.events.push(`case ${index + 1}`);
        return index === 0
          ? {
              result: { finalText: '', events: [], error: 'boom' },
              continuation: 'reset',
            }
          : ok(request.caseId);
      },
    });
    const results = await runDesktopBatch(client, requests(2));
    expect(client.events).toEqual([
      'prepare',
      'case 1',
      'reset before 2',
      'case 2',
      'dispose session',
    ]);
    expect(results[1]?.finalText).toBe('case-2');
  });

  it('submits nothing more when the app cannot be reset', async () => {
    const client = fakeClient({
      async runCase(_session, _request, index) {
        client.events.push(`case ${index + 1}`);
        return {
          result: { finalText: '', events: [], error: 'boom' },
          continuation: 'reset',
        };
      },
      async reset() {
        throw new Error(`reset refused with ${SECRET}`);
      },
    });
    const results = await runDesktopBatch(client, requests(3));
    expect(client.events).toEqual(['prepare', 'case 1', 'dispose session']);
    for (const result of results.slice(1)) {
      expect(result.error).toMatch(
        /^Not submitted because the Fake app could not be reset after an earlier failed case: /
      );
      expect(result.error).not.toContain(SECRET);
      expect(result.telemetry?.caseExecution).toEqual({
        status: 'not-submitted',
        continuation: 'blocked',
      });
    }
  });

  it('stops submitting after three failed cases in a row', async () => {
    const client = fakeClient({
      async runCase(_session, request, index) {
        client.events.push(`case ${index + 1}`);
        // Case 2 passes, so the run of failures starts again at case 3.
        return index === 1
          ? ok(request.caseId)
          : {
              result: {
                finalText: '',
                events: [],
                error: `no session for ${SECRET}`,
              },
              continuation: 'reset',
            };
      },
    });
    const results = await runDesktopBatch(client, requests(7));
    expect(client.events).toEqual([
      'prepare',
      'case 1',
      'reset before 2',
      'case 2',
      'case 3',
      'reset before 4',
      'case 4',
      'reset before 5',
      'case 5',
      'dispose session',
    ]);
    for (const result of results.slice(5)) {
      expect(result.error).toMatch(
        /^Not submitted because the last 3 Fake cases failed in a row \(latest: no session for \[REDACTED\]\)/
      );
      expect(result.telemetry?.caseExecution).toEqual({
        status: 'not-submitted',
        continuation: 'blocked',
      });
    }
  });

  it('keeps the cases that ran when a later case throws', async () => {
    const client = fakeClient({
      async runCase(_session, request, index) {
        client.events.push(`case ${index + 1}`);
        if (index === 1) throw new Error(`collector crashed with ${SECRET}`);
        return ok(request.caseId);
      },
    });
    const results = await runDesktopBatch(client, requests(3));
    expect(client.events).toEqual([
      'prepare',
      'case 1',
      'case 2',
      'dispose session',
    ]);
    expect(results[0]?.finalText).toBe('case-1');
    // The case that threw may have been submitted; its outcome is unknown.
    expect(results[1]?.error).toBe(
      'The Fake case failed: collector crashed with [REDACTED]'
    );
    expect(results[1]?.diagnostics).toEqual({ failureKind: 'process' });
    expect(results[2]?.error).toBe(
      'Not submitted because the Fake batch stopped: collector crashed with [REDACTED]'
    );
    // The client never ran it: infrastructure, not a grade.
    expect(results[2]?.diagnostics).toEqual({ failureKind: 'not-submitted' });
    expect(await exists(leasePath())).toBe(false);
  });

  it('reports each case that ran as it finishes, redacted', async () => {
    const reported: Array<[number, ClientRunResult]> = [];
    const client = fakeClient({
      async runCase(_session, request, index) {
        client.events.push(`case ${index + 1}`);
        return index === 0
          ? {
              result: {
                finalText: '',
                events: [],
                error: `failed with ${SECRET}`,
              },
              continuation: 'allowed',
            }
          : ok(request.caseId);
      },
    });
    const results = await runDesktopBatch(
      client,
      requests(2),
      async (index, result) => {
        client.events.push(`report ${index + 1}`);
        reported.push([index, result]);
      }
    );
    // Each case is reported before the next one runs.
    expect(client.events).toEqual([
      'prepare',
      'case 1',
      'report 1',
      'case 2',
      'report 2',
      'dispose session',
    ]);
    expect(reported[0]?.[1].error).toBe('failed with [REDACTED]');
    expect(reported[1]?.[1]).toEqual({ finalText: 'case-2', events: [] });
    // The returned results stay the batch's to finish.
    expect(results[1]?.telemetry?.batchCase).toBeDefined();
  });

  it('reports only the cases that ran', async () => {
    const reported: number[] = [];
    await runDesktopBatch(
      fakeClient({
        reset: undefined,
        async runCase() {
          return {
            result: { finalText: '', events: [] },
            continuation: 'reset',
          };
        },
      }),
      requests(3),
      async (index) => {
        reported.push(index);
      }
    );
    expect(reported).toEqual([0]);
  });

  it('stops submitting when a platform has no reset', async () => {
    const results = await runDesktopBatch(
      fakeClient({
        reset: undefined,
        async runCase() {
          return {
            result: { finalText: '', events: [] },
            continuation: 'reset',
          };
        },
      }),
      requests(2)
    );
    expect(results[1]?.error).toContain(
      'this Fake platform cannot reset between cases'
    );
  });

  it('refuses to attribute one native session to two cases', async () => {
    const claims: boolean[] = [];
    await runDesktopBatch(
      fakeClient({
        async runCase(_session, request, _index, ledger) {
          claims.push(ledger.claim('native-1'));
          return ok(request.caseId);
        },
      }),
      requests(2)
    );
    expect(claims).toEqual([true, false]);
  });

  it('redacts every case error', async () => {
    const results = await runDesktopBatch(
      fakeClient({
        async runCase() {
          return {
            result: {
              finalText: '',
              events: [],
              error: `failed with ${SECRET}`,
            },
            continuation: 'allowed',
          };
        },
      }),
      requests(1)
    );
    expect(results[0]?.error).not.toContain(SECRET);
  });

  it('disposes the prepared session when readiness fails, and throws redacted', async () => {
    const client = fakeClient({
      async ready() {
        throw new Error(`MCP not ready (${SECRET})`);
      },
    });
    const failure = await runDesktopBatch(client, requests(2)).catch(
      (error: unknown) => error
    );
    expect(String(failure)).toContain('MCP not ready');
    expect(String(failure)).not.toContain(SECRET);
    expect(client.events).toEqual(['prepare', 'dispose session']);
    expect(await exists(leasePath())).toBe(false);
  });

  it('surfaces a secret-free error as is, keeping its class and fields', async () => {
    const readiness = new McpReadinessError('Fake', [
      { label: 'acme', status: 'connected', toolCount: 0, elapsedMs: 1 },
    ]);
    const failure = await runDesktopBatch(
      fakeClient({
        async ready() {
          throw readiness;
        },
      }),
      requests(1)
    ).catch((error: unknown) => error);
    expect(failure).toBe(readiness);
    expect((failure as McpReadinessError).servers).toHaveLength(1);
  });

  it('keeps results and the lease when cleanup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results: ClientRunResult[] = await runDesktopBatch(
      fakeClient({
        async dispose() {
          throw new Error('restore failed');
        },
      }),
      requests(1)
    );
    expect(results[0]?.error).toBe(
      'Fake batch cleanup failed; desktop lock retained for inspection: restore failed'
    );
    expect(results[0]?.telemetry?.batchFailure).toMatchObject({
      kind: 'cleanup_failed',
    });
    // The desktop failed, not the client.
    expect(results[0]?.diagnostics).toEqual({ failureKind: 'cleanup' });
    expect(console.warn).toHaveBeenCalledWith(
      '[mst] Fake batch cleanup failed; desktop lock retained for inspection: restore failed'
    );
    expect(await exists(leasePath())).toBe(true);
  });

  it('reports both an execution failure and a cleanup failure', async () => {
    const failure = await runDesktopBatch(
      fakeClient({
        async runCase() {
          throw new Error('driver crashed');
        },
        async dispose() {
          throw new Error('restore failed');
        },
      }),
      requests(1)
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'Error: driver crashed',
      expect.stringContaining('restore failed'),
    ]);
  });

  it('adds client lifecycle telemetry to every result', async () => {
    const results = await runDesktopBatch(
      fakeClient({ batchTelemetry: () => ({ setupMs: 12 }) }),
      requests(2)
    );
    expect(results.map((result) => result.telemetry?.batchLifecycle)).toEqual([
      { setupMs: 12 },
      { setupMs: 12 },
    ]);
  });
});

describe('requireIdenticalClientSettings', () => {
  it('accepts identical settings and names the client otherwise', () => {
    expect(() =>
      requireIdenticalClientSettings('Fake', [{ a: 1 }, { a: 1 }])
    ).not.toThrow();
    expect(() =>
      requireIdenticalClientSettings('Fake', [{ a: 1 }, { a: 2 }])
    ).toThrow('Fake batch requires identical client settings for all cases.');
  });
});
