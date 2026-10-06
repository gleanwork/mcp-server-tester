import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  requireIdenticalHostSettings,
  runDesktopBatch,
  type DesktopCaseOutcome,
  type DesktopHostAdapter,
} from './desktopBatch.js';
import type { HostBatchRequest, HostRunResult } from './evalFrameworkTypes.js';
import { McpReadinessError } from './mcpReadiness.js';

const SECRET = 'sk-desktop-secret';
let leaseDirectory = '';

beforeEach(async () => {
  leaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-lease-'));
});
afterEach(async () => {
  await fs.rm(leaseDirectory, { recursive: true, force: true });
});

function requests(count: number): HostBatchRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `case-${index + 1}`,
    trial: 0,
    input: { prompt: `prompt ${index + 1}`, servers: [] },
    config: { type: 'fake' },
  })) as HostBatchRequest[];
}

const ok = (text: string): DesktopCaseOutcome => ({
  result: { finalText: text, events: [] },
  continuation: 'allowed',
});

/** A fake desktop host that records its lifecycle. */
function fakeHost(
  overrides: Partial<DesktopHostAdapter<{ id: string }>> = {}
): DesktopHostAdapter<{ id: string }> & { events: string[] } {
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
    const host = fakeHost();
    const results = await runDesktopBatch(host, requests(2));
    expect(results.map((result) => result.finalText)).toEqual([
      'case-1',
      'case-2',
    ]);
    expect(host.events).toEqual([
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
    const host = fakeHost();
    expect(await runDesktopBatch(host, [])).toEqual([]);
    expect(host.events).toEqual([]);
  });

  it('refuses a second batch while the desktop is leased', async () => {
    let release: () => void = () => {};
    const first = runDesktopBatch(
      fakeHost({
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
    await expect(runDesktopBatch(fakeHost(), requests(1))).rejects.toThrow(
      'Fake desktop is locked by another run or an interrupted run'
    );
    release();
    await first;
  });

  it('resets after a case that left the app unknown', async () => {
    const host = fakeHost({
      async runCase(_session, request, index) {
        host.events.push(`case ${index + 1}`);
        return index === 0
          ? {
              result: { finalText: '', events: [], error: 'boom' },
              continuation: 'reset',
            }
          : ok(request.caseId);
      },
    });
    const results = await runDesktopBatch(host, requests(2));
    expect(host.events).toEqual([
      'prepare',
      'case 1',
      'reset before 2',
      'case 2',
      'dispose session',
    ]);
    expect(results[1]?.finalText).toBe('case-2');
  });

  it('submits nothing more when the app cannot be reset', async () => {
    const host = fakeHost({
      async runCase(_session, _request, index) {
        host.events.push(`case ${index + 1}`);
        return {
          result: { finalText: '', events: [], error: 'boom' },
          continuation: 'reset',
        };
      },
      async reset() {
        throw new Error(`reset refused with ${SECRET}`);
      },
    });
    const results = await runDesktopBatch(host, requests(3));
    expect(host.events).toEqual(['prepare', 'case 1', 'dispose session']);
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

  it('stops submitting when a platform has no reset', async () => {
    const results = await runDesktopBatch(
      fakeHost({
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
      fakeHost({
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
      fakeHost({
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
    const host = fakeHost({
      async ready() {
        throw new Error(`MCP not ready (${SECRET})`);
      },
    });
    const failure = await runDesktopBatch(host, requests(2)).catch(
      (error: unknown) => error
    );
    expect(String(failure)).toContain('MCP not ready');
    expect(String(failure)).not.toContain(SECRET);
    expect(host.events).toEqual(['prepare', 'dispose session']);
    expect(await exists(leasePath())).toBe(false);
  });

  it('surfaces a secret-free error as is, keeping its class and fields', async () => {
    const readiness = new McpReadinessError('Fake', [
      { label: 'acme', status: 'connected', toolCount: 0, elapsedMs: 1 },
    ]);
    const failure = await runDesktopBatch(
      fakeHost({
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
    const results: HostRunResult[] = await runDesktopBatch(
      fakeHost({
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
    expect(await exists(leasePath())).toBe(true);
  });

  it('reports both an execution failure and a cleanup failure', async () => {
    const failure = await runDesktopBatch(
      fakeHost({
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

  it('adds host lifecycle telemetry to every result', async () => {
    const results = await runDesktopBatch(
      fakeHost({ batchTelemetry: () => ({ setupMs: 12 }) }),
      requests(2)
    );
    expect(results.map((result) => result.telemetry?.batchLifecycle)).toEqual([
      { setupMs: 12 },
      { setupMs: 12 },
    ]);
  });
});

describe('requireIdenticalHostSettings', () => {
  it('accepts identical settings and names the host otherwise', () => {
    expect(() =>
      requireIdenticalHostSettings('Fake', [{ a: 1 }, { a: 1 }])
    ).not.toThrow();
    expect(() =>
      requireIdenticalHostSettings('Fake', [{ a: 1 }, { a: 2 }])
    ).toThrow('Fake batch requires identical host settings for all cases.');
  });
});
