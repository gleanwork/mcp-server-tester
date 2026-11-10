import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '../../utils/describeError.js';
import { redactClientError } from '../clientSecrets.js';
import {
  CloudPermissionWriteNotSentError,
  configureCloudConnectors,
  planCloudConnectors,
  verifyCloudConnectorEvents,
  recoverCloudConnectorSettings,
  type CloudConnectorSnapshot,
  type CloudConnectorIO,
  type PermissionPatch,
} from './claudeAiConnectors.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof files>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    rm: vi.fn(actual.rm),
  };
});

const snapshot: CloudConnectorSnapshot = {
  accountId: 'account',
  organizationId: 'org',
  permissions: {},
  servers: [
    {
      id: 'glean',
      name: 'Glean',
      nativeName: 'Glean',
      connectionState: 'connected',
      tools: [
        {
          name: 'search',
          enabledKey: 'glean:search',
          approvalKey: 'glean:search-hash',
          readOnly: true,
        },
        {
          name: 'send',
          enabledKey: 'glean:send',
          approvalKey: 'glean:send-hash',
          readOnly: false,
        },
        {
          name: 'unknown',
          enabledKey: 'glean:unknown',
          approvalKey: 'glean:unknown-hash',
        },
      ],
    },
    {
      id: 'jira',
      name: 'Jira',
      nativeName: 'Jira',
      connectionState: 'connected',
      tools: [
        {
          name: 'read',
          enabledKey: 'jira:read',
          approvalKey: 'jira:read-hash',
          readOnly: true,
        },
      ],
    },
  ],
};

const policySnapshot: CloudConnectorSnapshot = {
  accountId: 'acme-account',
  organizationId: 'acme-org',
  permissions: {},
  servers: [
    {
      id: 'docs',
      name: 'Acme Documents',
      nativeName: 'Acme_Documents',
      connectionState: 'connected',
      tools: [
        {
          name: 'search',
          enabledKey: 'docs:search',
          approvalKey: 'docs:search-hash',
          readOnly: true,
        },
        {
          name: 'send',
          enabledKey: 'docs:send',
          approvalKey: 'docs:send-hash',
          readOnly: false,
        },
      ],
    },
    {
      id: 'tasks',
      name: 'Task Board',
      nativeName: 'Task_Board',
      connectionState: 'connected',
      tools: [
        {
          name: 'read',
          enabledKey: 'tasks:read',
          approvalKey: 'tasks:read-hash',
          readOnly: true,
        },
      ],
    },
  ],
};

function permissionFixture() {
  const state = structuredClone(policySnapshot);
  const io: CloudConnectorIO = {
    inspect: vi.fn(async () => structuredClone(state)),
    read: vi.fn(async () => structuredClone(state)),
    patch: vi.fn<CloudConnectorIO['patch']>(async (_identity, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete state.permissions[key];
        else state.permissions[key] = value;
      }
    }),
    assertTaskComplete: vi.fn(async () => undefined),
  };
  return { state, io };
}

const transactionConfig = {
  servers: { docs: { policy: 'read-only' as const } },
};

async function withJournal(
  test: (path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-transaction-'));
  try {
    await test(join(dir, 'journal.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function journalAt(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    version: number;
    accountId: string;
    organizationId: string;
    original: PermissionPatch;
    applied: PermissionPatch;
    pendingWrite?: {
      purpose: 'configure' | 'restore';
      patch: PermissionPatch;
      expected: PermissionPatch;
    };
    pendingTask?: { startedAt: string; sessionId?: string };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('fail-closed cloud permission transactions', () => {
  it('publishes an owner-only pre-dispatch marker for configuration and restoration', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const dispatch = io.patch;
      const seen: Awaited<ReturnType<typeof journalAt>>[] = [];
      io.patch = vi.fn<CloudConnectorIO['patch']>(
        async (identity, patch, expected) => {
          const journal = await journalAt(path);
          expect(journal.pendingWrite).toEqual({
            purpose: seen.length === 0 ? 'configure' : 'restore',
            patch,
            expected,
          });
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          seen.push(journal);
          await dispatch(identity, patch, expected);
        }
      );
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const configured = await journalAt(path);
      expect(configured.version).toBe(2);
      expect(configured.pendingWrite).toBeUndefined();
      await session.restore();
      expect(seen).toHaveLength(2);
      expect(seen[1]!.original).toEqual(seen[0]!.original);
      expect(seen[1]!.applied).toEqual(seen[0]!.applied);
      expect(state.permissions).toEqual({});
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it.each(['timeout', 'abort', 'transport disconnect', 'ambiguous HTTP 500'])(
    'retains a %s outcome even while a deferred write still reads as original',
    async (failure) => {
      await withJournal(async (path) => {
        const { state, io } = permissionFixture();
        const apply = io.patch;
        let commit: (() => Promise<void>) | undefined;
        io.patch = vi.fn<CloudConnectorIO['patch']>(
          async (identity, patch, expected) => {
            commit = () => apply(identity, patch, expected);
            throw new Error(failure);
          }
        );
        await expect(
          configureCloudConnectors(io, transactionConfig, path)
        ).rejects.toThrow(new RegExp(`${failure}.*unknown`, 'is'));
        const pending = await readFile(path, 'utf8');
        expect(state.permissions).toEqual({});
        expect((await journalAt(path)).pendingWrite?.purpose).toBe('configure');
        vi.mocked(io.read).mockClear();
        await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
          /unknown.*manual/is
        );
        await expect(
          configureCloudConnectors(io, transactionConfig, path)
        ).rejects.toThrow(/unknown/i);
        expect(io.read).not.toHaveBeenCalled();
        expect(io.inspect).toHaveBeenCalledTimes(1);
        expect(io.patch).toHaveBeenCalledTimes(1);
        await commit!();
        expect(state.permissions['docs:search']).toBe(true);
        await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
          /unknown/i
        );
        expect(await readFile(path, 'utf8')).toBe(pending);
      });
    }
  );

  it.each(['configure', 'restore'] as const)(
    'fails closed after a crash with a persisted %s marker, even before dispatch',
    async (purpose) => {
      await withJournal(async (path) => {
        const { io } = permissionFixture();
        const saved = {
          version: 2,
          accountId: policySnapshot.accountId,
          organizationId: policySnapshot.organizationId,
          original: { 'docs:search': null },
          applied: { 'docs:search': true },
          pendingWrite: {
            purpose,
            patch: { 'docs:search': purpose === 'configure' ? true : null },
            expected: { 'docs:search': purpose === 'configure' ? null : true },
          },
        };
        await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
        await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
          /unknown/i
        );
        expect(io.patch).not.toHaveBeenCalled();
        expect(io.read).not.toHaveBeenCalled();
        expect(await journalAt(path)).toEqual(saved);
      });
    }
  );

  it('does not clear an acknowledged write when verification fails', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      vi.mocked(io.read).mockRejectedValueOnce(
        new Error('verification disconnected')
      );
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/verification disconnected.*unknown/is);
      expect(state.permissions['docs:search']).toBe(true);
      expect((await journalAt(path)).pendingWrite?.purpose).toBe('configure');
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /unknown/i
      );
      expect(io.patch).toHaveBeenCalledTimes(1);
    });
  });

  it('can clean up only a proven not-sent configuration failure', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      io.patch = vi.fn(async () => {
        throw new CloudPermissionWriteNotSentError('preflight account changed');
      });
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow('preflight account changed');
      expect(state.permissions).toEqual({});
      expect(io.patch).toHaveBeenCalledTimes(1);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('does not infer a not-sent outcome from an error message or name', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const generic = new Error('preflight rejection: PATCH was not sent');
      generic.name = 'CloudPermissionWriteNotSentError';
      io.patch = vi.fn(async () => {
        throw generic;
      });
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/outcome is unknown/i);
      expect((await journalAt(path)).pendingWrite?.purpose).toBe('configure');
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /unknown/i
      );
      expect(io.patch).toHaveBeenCalledTimes(1);
    });
  });

  it('retains the marker and both errors if recording a proven not-sent outcome fails', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const { rename: realRename } =
        await vi.importActual<typeof files>('node:fs/promises');
      let updates = 0;
      vi.mocked(files.rename).mockImplementation(async (...args) => {
        if (++updates === 2) throw new Error('not-sent journal update failed');
        await realRename(...args);
      });
      io.patch = vi.fn(async () => {
        throw new CloudPermissionWriteNotSentError('preflight unavailable');
      });
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(
        /preflight unavailable.*not-sent journal update failed.*unknown/is
      );
      expect((await journalAt(path)).pendingWrite?.purpose).toBe('configure');
      expect(io.patch).toHaveBeenCalledTimes(1);
    });
  });

  it('retains an unknown restoration write even when it appears already restored', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const apply = io.patch;
      io.patch = vi.fn<CloudConnectorIO['patch']>(
        async (identity, patch, expected) => {
          await apply(identity, patch, expected);
          throw new Error('restore acknowledgement lost');
        }
      );
      await expect(session.restore()).rejects.toThrow(
        'restore acknowledgement lost'
      );
      expect(state.permissions).toEqual({});
      expect((await journalAt(path)).pendingWrite?.purpose).toBe('restore');
      await expect(session.restore()).rejects.toThrow(/unknown/i);
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/unknown/i);
      expect(io.patch).toHaveBeenCalledTimes(1);
    });
  });

  it('retains a settled journal for retry after a proven not-sent restoration', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      vi.mocked(io.patch).mockRejectedValueOnce(
        new CloudPermissionWriteNotSentError('read-only preflight unavailable')
      );
      await expect(session.restore()).rejects.toThrow(
        'read-only preflight unavailable'
      );
      expect((await journalAt(path)).pendingWrite).toBeUndefined();
      expect(state.permissions['docs:search']).toBe(true);
      await session.restore();
      expect(state.permissions).toEqual({});
    });
  });

  it('does not dispatch when atomically publishing a marker fails, preserving the previous journal', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const previous = await readFile(path, 'utf8');
      const rename = vi
        .mocked(files.rename)
        .mockRejectedValueOnce(new Error('atomic rename denied'));
      await expect(session.restore()).rejects.toThrow('atomic rename denied');
      expect(await readFile(path, 'utf8')).toBe(previous);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(io.patch).toHaveBeenCalledTimes(1);
      expect(await files.readdir(join(path, '..'))).toEqual(['journal.json']);
      rename.mockReset();
      await session.restore();
    });
  });

  it('retains the unresolved marker after an acknowledged verified write when clearing it fails', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const { rename: realRename } =
        await vi.importActual<typeof files>('node:fs/promises');
      let updates = 0;
      vi.mocked(files.rename).mockImplementation(async (...args) => {
        updates++;
        if (updates === 2) throw new Error('cannot publish acknowledgement');
        await realRename(...args);
      });
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/cannot publish acknowledgement.*unknown/is);
      expect(state.permissions['docs:search']).toBe(true);
      const unresolved = await journalAt(path);
      expect(unresolved.pendingWrite?.purpose).toBe('configure');
      expect(unresolved.original['docs:search']).toBeNull();
      expect(unresolved.applied['docs:search']).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /unknown/i
      );
      expect(io.patch).toHaveBeenCalledTimes(1);
      expect(await files.readdir(join(path, '..'))).toEqual(['journal.json']);
    });
  });

  it.each(['write', 'file sync'])(
    'leaves the prior owner-only journal intact when temporary %s fails',
    async (boundary) => {
      await withJournal(async (path) => {
        const { io } = permissionFixture();
        const session = await configureCloudConnectors(
          io,
          transactionConfig,
          path
        );
        const before = await readFile(path, 'utf8');
        const { open: realOpen } =
          await vi.importActual<typeof files>('node:fs/promises');
        vi.mocked(files.open).mockImplementation(async (...args) => {
          const file = await realOpen(...args);
          if (String(args[0]).endsWith('.tmp')) {
            expect((await file.stat()).mode & 0o777).toBe(0o600);
            if (boundary === 'write') {
              const write = file.writeFile.bind(file);
              vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
                await write('{"partial":');
                throw new Error('temporary write failed');
              });
            } else {
              vi.spyOn(file, 'sync').mockRejectedValueOnce(
                new Error('temporary file sync failed')
              );
            }
          }
          return file;
        });
        await expect(session.restore()).rejects.toThrow(/temporary .*failed/);
        expect(await readFile(path, 'utf8')).toBe(before);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(io.patch).toHaveBeenCalledTimes(1);
        expect(await files.readdir(join(path, '..'))).toEqual(['journal.json']);
      });
    }
  );

  it('fails closed without dispatch if directory sync fails after publishing the marker', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const initial = await journalAt(path);
      const { open: realOpen } =
        await vi.importActual<typeof files>('node:fs/promises');
      vi.mocked(files.open).mockImplementation(async (...args) => {
        const file = await realOpen(...args);
        if (String(args[0]) === join(path, '..'))
          vi.spyOn(file, 'sync').mockRejectedValueOnce(
            new Error('directory sync failed')
          );
        return file;
      });
      await expect(session.restore()).rejects.toThrow('directory sync failed');
      const pending = await journalAt(path);
      expect(pending.pendingWrite?.purpose).toBe('restore');
      expect(pending.original).toEqual(initial.original);
      expect(pending.applied).toEqual(initial.applied);
      expect(io.patch).toHaveBeenCalledTimes(1);
      await expect(session.restore()).rejects.toThrow(/unknown/i);
    });
  });

  it('never replaces an unexpected journal during exclusive initial publication', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const other = '{"version":1,"original":{"keep":true}}';
      io.inspect = vi.fn(async () => {
        await writeFile(path, other, { mode: 0o600 });
        return structuredClone(state);
      });
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path, 'utf8')).toBe(other);
      expect(io.patch).not.toHaveBeenCalled();
      expect(await files.readdir(join(path, '..'))).toEqual(['journal.json']);
    });
  });

  it('can finish recovery after a crash boundary between verified restoration and journal deletion', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const { rm: realRm } =
        await vi.importActual<typeof files>('node:fs/promises');
      vi.mocked(files.rm).mockImplementation(async (...args) => {
        if (String(args[0]) === path)
          throw new Error('journal removal unavailable');
        await realRm(...args);
      });
      await expect(session.restore()).rejects.toThrow(
        'journal removal unavailable'
      );
      expect(state.permissions).toEqual({});
      const settled = await journalAt(path);
      expect(settled.pendingWrite).toBeUndefined();
      expect(settled.pendingTask).toBeUndefined();
      vi.mocked(files.rm).mockReset();
      await expect(recoverCloudConnectorSettings(io, path)).resolves.toBe(true);
      expect(io.patch).toHaveBeenCalledTimes(2);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('retains legacy journals that cannot prove write outcomes or task completion', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const saved = JSON.stringify({
        version: 1,
        accountId: 'acme-account',
        organizationId: 'acme-org',
        original: {},
        applied: {},
      });
      await writeFile(path, saved, { mode: 0o600 });
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /version 1.*manual/is
      );
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/version 1/i);
      expect(await readFile(path, 'utf8')).toBe(saved);
      expect(io.read).not.toHaveBeenCalled();
      expect(io.inspect).not.toHaveBeenCalled();
      expect(io.patch).not.toHaveBeenCalled();
    });
  });

  it('exposes both configuration and rollback errors in the aggregate message', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      io.patch = vi.fn(async () => {
        throw new CloudPermissionWriteNotSentError(
          'preflight unavailable Bearer private-token'
        );
      });
      vi.mocked(io.read).mockRejectedValueOnce(
        new Error('rollback account read failed')
      );
      const error: unknown = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect(describeError(error)).toMatch(
        /preflight unavailable.*rollback account read failed/is
      );
      const redacted = redactClientError(error, ['private-token'], 'fallback');
      expect(redacted).toMatch(
        /preflight unavailable.*rollback account read failed/is
      );
      expect(redacted).not.toContain('private-token');
      expect((await journalAt(path)).pendingWrite).toBeUndefined();
    });
  });
});

describe('durable cloud task ownership', () => {
  it('persists the task before submit, binds once, and gates restoration on provider proof', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const initial = await journalAt(path);
      await session.beginTask();
      const unbound = await journalAt(path);
      expect(unbound.pendingTask).toEqual({ startedAt: expect.any(String) });
      expect(Number.isFinite(Date.parse(unbound.pendingTask!.startedAt))).toBe(
        true
      );
      await expect(session.restore()).rejects.toThrow(/unbound.*manual/is);
      expect(io.patch).toHaveBeenCalledTimes(1);
      expect(io.assertTaskComplete).not.toHaveBeenCalled();
      await expect(session.beginTask()).rejects.toThrow(/pending task/i);
      await session.bindTask('cse_trial_1');
      await expect(session.bindTask('cse_trial_1')).rejects.toThrow(
        /already bound/i
      );
      await expect(session.bindTask('cse_another')).rejects.toThrow(
        /already bound/i
      );
      const bound = await journalAt(path);
      expect(bound.pendingTask).toEqual({
        ...unbound.pendingTask,
        sessionId: 'cse_trial_1',
      });
      expect(bound.original).toEqual(initial.original);
      expect(bound.applied).toEqual(initial.applied);
      vi.mocked(io.assertTaskComplete!).mockRejectedValueOnce(
        new Error('task still running')
      );
      await expect(session.restore()).rejects.toThrow('task still running');
      expect(state.permissions['docs:search']).toBe(true);
      expect((await journalAt(path)).pendingTask).toEqual(bound.pendingTask);
      await session.confirmTaskComplete();
      expect(io.assertTaskComplete).toHaveBeenCalledWith(bound.pendingTask);
      expect((await journalAt(path)).pendingTask).toBeUndefined();
      await session.beginTask();
      await session.bindTask('cse_trial_2');
      await session.restore();
      expect(io.assertTaskComplete).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 'cse_trial_2' })
      );
      expect(state.permissions).toEqual({});
    });
  });

  it.each(['../cse_trial', 'local_cse_trial', 'cse_', 'cse_trial/other', ''])(
    'does not bind invalid identity %s',
    async (id) => {
      await withJournal(async (path) => {
        const { io } = permissionFixture();
        const session = await configureCloudConnectors(
          io,
          transactionConfig,
          path
        );
        await expect(session.bindTask('cse_no_task')).rejects.toThrow(
          /no pending task/i
        );
        await session.beginTask();
        const original = await readFile(path, 'utf8');
        await expect(session.bindTask(id)).rejects.toThrow(/invalid.*session/i);
        expect(await readFile(path, 'utf8')).toBe(original);
        await expect(session.confirmTaskComplete()).rejects.toThrow(/unbound/i);
      });
    }
  );

  it('retains a bound task across recovery without provider completion evidence', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      delete io.assertTaskComplete;
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      await session.beginTask();
      await session.bindTask('cse_unfinished');
      const original = await readFile(path, 'utf8');
      await expect(session.confirmTaskComplete()).rejects.toThrow(
        /completion proof.*manual/is
      );
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /completion proof/i
      );
      await expect(
        configureCloudConnectors(io, transactionConfig, path)
      ).rejects.toThrow(/completion proof/i);
      expect(io.patch).toHaveBeenCalledTimes(1);
      expect(await readFile(path, 'utf8')).toBe(original);
    });
  });

  it.each(['begin', 'bind', 'confirm'] as const)(
    'retains the preceding task state when atomic %s publication fails',
    async (boundary) => {
      await withJournal(async (path) => {
        const { io } = permissionFixture();
        const session = await configureCloudConnectors(
          io,
          transactionConfig,
          path
        );
        if (boundary !== 'begin') await session.beginTask();
        if (boundary === 'confirm') await session.bindTask('cse_task');
        const previous = await readFile(path, 'utf8');
        vi.mocked(files.rename).mockRejectedValueOnce(
          new Error('task journal publish failed')
        );
        const operation =
          boundary === 'begin'
            ? session.beginTask()
            : boundary === 'bind'
              ? session.bindTask('cse_task')
              : session.confirmTaskComplete();
        await expect(operation).rejects.toThrow('task journal publish failed');
        expect(await readFile(path, 'utf8')).toBe(previous);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(io.patch).toHaveBeenCalledTimes(1);
        if (boundary === 'bind')
          await expect(session.restore()).rejects.toThrow(/unbound/i);
        if (boundary === 'confirm') {
          expect(io.assertTaskComplete).toHaveBeenCalledTimes(1);
          expect((await journalAt(path)).pendingTask?.sessionId).toBe(
            'cse_task'
          );
        }
      });
    }
  );

  it('requires completion proof even when configuration changed no permissions', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        { default: 'inherit' },
        path
      );
      expect(io.patch).not.toHaveBeenCalled();
      await session.beginTask();
      await expect(recoverCloudConnectorSettings(io, path)).rejects.toThrow(
        /unbound/i
      );
      expect((await journalAt(path)).original).toEqual({});
      expect(io.patch).not.toHaveBeenCalled();
      expect(io.assertTaskComplete).not.toHaveBeenCalled();
    });
  });

  it('serializes task changes so concurrent begin calls cannot overwrite task ownership', async () => {
    await withJournal(async (path) => {
      const { io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      const results = await Promise.allSettled([
        session.beginTask(),
        session.beginTask(),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect((await journalAt(path)).pendingTask).toEqual({
        startedAt: expect.any(String),
      });
      await expect(session.restore()).rejects.toThrow(/unbound/i);
    });
  });

  it('rejects a provider proof if account identity changes during verification', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      await session.beginTask();
      await session.bindTask('cse_task');
      io.assertTaskComplete = vi.fn(async () => {
        state.accountId = 'other-account';
      });
      await expect(session.confirmTaskComplete()).rejects.toThrow(
        /account or organization changed/i
      );
      expect((await journalAt(path)).pendingTask?.sessionId).toBe('cse_task');
      expect(io.patch).toHaveBeenCalledTimes(1);
    });
  });

  it('checks account identity before asking for completion proof', async () => {
    await withJournal(async (path) => {
      const { state, io } = permissionFixture();
      const session = await configureCloudConnectors(
        io,
        transactionConfig,
        path
      );
      await session.beginTask();
      await session.bindTask('cse_unfinished');
      state.organizationId = 'other-org';
      await expect(session.confirmTaskComplete()).rejects.toThrow(
        /account or organization changed/i
      );
      await expect(session.restore()).rejects.toThrow(
        /account or organization changed/i
      );
      expect(io.assertTaskComplete).not.toHaveBeenCalled();
      expect((await journalAt(path)).pendingTask?.sessionId).toBe(
        'cse_unfinished'
      );
    });
  });
});

describe('cloud connector configuration', () => {
  it.each([false, true])(
    'refuses preparation when an excluded connected inventory fails (saved keys: %s)',
    async (savedKeys) => {
      const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-inventory-'));
      const state = structuredClone(policySnapshot);
      state.servers[1]!.tools = [];
      state.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
      if (savedKeys) state.permissions['tasks:old-tool'] = true;
      const original = structuredClone(state.permissions);
      const io: CloudConnectorIO = {
        inspect: async () => structuredClone(state),
        read: async () => structuredClone(state),
        async patch(_identity, patch) {
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete state.permissions[key];
            else state.permissions[key] = value;
          }
        },
      };
      try {
        const journal = join(dir, 'journal.json');
        await expect(
          configureCloudConnectors(
            io,
            { servers: { docs: { policy: 'read-only' } } },
            journal
          )
        ).rejects.toThrow(/Task Board.*Tool inventory HTTP 503/);
        expect(state.permissions).toEqual(original);
        await expect(readFile(journal)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('recovers an earlier transaction before refusing an excluded inventory gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-recovery-'));
    const state = structuredClone(policySnapshot);
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch, expected) {
        for (const [key, value] of Object.entries(patch)) {
          expect(state.permissions[key] ?? null).toEqual(expected[key]);
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
        }
      },
    };
    try {
      const journal = join(dir, 'journal.json');
      const config = { servers: { docs: { policy: 'read-only' as const } } };
      await configureCloudConnectors(io, config, journal);
      expect(state.permissions['docs:search']).toBe(true);
      state.servers[1]!.tools = [];
      state.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
      await expect(
        configureCloudConnectors(io, config, journal)
      ).rejects.toThrow(/Task Board.*Tool inventory HTTP 503/);
      expect(state.permissions).toEqual({});
      await expect(readFile(journal)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(['Acme_Documents', 'Acme Documents'])(
    'recognizes the pending server name %s without widening allowed tools',
    (pendingName) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      const init = {
        payload: {
          type: 'system',
          subtype: 'init',
          tools: ['ToolSearch'],
          mcp_servers: [{ name: pendingName, status: 'pending' }],
        },
      };
      const result = verifyCloudConnectorEvents(plan, [init]);
      expect(result).toMatchObject({
        allowedTools: ['mcp__Acme_Documents__search'],
        observedAllowedTools: [],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        pendingServers: [pendingName],
        catalogComplete: false,
      });
      const search = {
        payload: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'lookup', name: 'ToolSearch' }],
          },
        },
      };
      const reference = (tool: string) => ({
        payload: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'lookup',
                content: [{ type: 'tool_reference', tool_name: tool }],
              },
            ],
          },
        },
      });
      expect(
        verifyCloudConnectorEvents(plan, [
          init,
          search,
          reference('mcp__Acme_Documents__search'),
        ]).observedAllowedTools
      ).toEqual(['mcp__Acme_Documents__search']);
      for (const tool of [
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
        'mcp__Task_Board__read',
        'mcp__Task_Board__new_tool',
      ]) {
        expect(() =>
          verifyCloudConnectorEvents(plan, [init, search, reference(tool)])
        ).toThrow('1 unexpected tools');
      }
    }
  );

  it.each(['Acme_Documents', 'Acme Documents'])(
    'recognizes pending name %s for an inherited connector with a tool override',
    (name) => {
      const plan = planCloudConnectors(policySnapshot, {
        default: 'inherit',
        servers: { docs: { policy: 'inherit', tools: { search: 'allow' } } },
      });
      expect(
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name, status: 'pending' }],
            },
          },
        ])
      ).toMatchObject({
        allowedTools: ['mcp__Acme_Documents__search'],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        catalogComplete: false,
      });
    }
  );

  it('refuses an explicit block with an unavailable connected inventory but permits inheritance', () => {
    const unavailable = structuredClone(policySnapshot);
    unavailable.servers[1]!.tools = [];
    unavailable.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
    expect(() =>
      planCloudConnectors(unavailable, {
        default: 'inherit',
        servers: { tasks: { policy: 'block' } },
      })
    ).toThrow(/Task Board.*Tool inventory HTTP 503/);
    expect(
      planCloudConnectors(unavailable, { default: 'inherit' }).patch
    ).toEqual({});
  });

  it.each(['Task_Board', 'Task Board', 'Acme.Documents'])(
    'does not excuse missing allowed tools for unrelated pending name %s',
    (pendingName) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      expect(() =>
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name: pendingName, status: 'pending' }],
            },
          },
        ])
      ).toThrow('Missing: mcp__Acme_Documents__search');
    }
  );

  it.each(['Acme_Documents', 'Acme Documents'])(
    'still requires allowed tools when server %s is no longer pending',
    (name) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      expect(() =>
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name, status: 'connected' }],
            },
          },
        ])
      ).toThrow('Missing: mcp__Acme_Documents__search');
    }
  );

  it('verifies lazy-loaded tools without treating a pending init catalog as complete', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    const init = {
      payload: {
        type: 'system',
        subtype: 'init',
        tools: ['ToolSearch'],
        mcp_servers: [{ name: 'Glean', status: 'pending' }],
      },
    };
    const call = {
      payload: {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call-1', name: 'mcp__Glean__search' },
          ],
        },
      },
    };
    const result = verifyCloudConnectorEvents(plan, [init, call]);
    expect(result.observedAllowedTools).toEqual(['mcp__Glean__search']);
    expect(result.catalogComplete).toBe(false);
    expect(
      verifyCloudConnectorEvents(plan, [init]).unobservedAllowedTools
    ).toEqual(['mcp__Glean__search']);
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        init,
        {
          payload: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'mcp__Glean__send' }],
            },
          },
        },
      ])
    ).toThrow('unexpected');
    const search = {
      payload: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch' }],
        },
      },
    };
    const references = {
      payload: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search',
              content: [
                { type: 'tool_reference', tool_name: 'mcp__Glean__send' },
              ],
            },
          ],
        },
      },
    };
    expect(() =>
      verifyCloudConnectorEvents(plan, [init, search, references])
    ).toThrow('unexpected');
  });
  it.each(['text', 'text-blocks'] as const)(
    'verifies allowed, blocked and newly surfaced managed tools in ToolSearch %s results',
    (format) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      const init = {
        payload: { type: 'system', subtype: 'init', tools: ['ToolSearch'] },
      };
      const search = {
        payload: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'lookup', name: 'ToolSearch' }],
          },
        },
      };
      const result = (tools: string[]) => {
        const text = `Available: ${tools.join(', ')}.`;
        return {
          payload: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'lookup',
                  content: format === 'text' ? text : [{ type: 'text', text }],
                },
              ],
            },
          },
        };
      };
      expect(
        verifyCloudConnectorEvents(plan, [
          init,
          search,
          result(['mcp__Acme_Documents__search']),
        ])
      ).toMatchObject({
        observedAllowedTools: ['mcp__Acme_Documents__search'],
        unobservedAllowedTools: [],
        catalogComplete: true,
      });
      for (const tool of [
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
        'mcp__Task_Board__read',
        'mcp__Task_Board__new_tool',
      ]) {
        expect(() =>
          verifyCloudConnectorEvents(plan, [
            init,
            search,
            result(['mcp__Acme_Documents__search', tool]),
          ])
        ).toThrow(`Unexpected: ${tool}. Missing: none.`);
      }
    }
  );

  it.each(['text', 'text-blocks', 'references'] as const)(
    'does not treat unrelated MCP %s results as ToolSearch catalog evidence',
    (format) => {
      const plan = planCloudConnectors(policySnapshot, {
        default: 'inherit',
        servers: { docs: { policy: 'read-only' } },
      });
      const tools = [
        'mcp__Acme_Documents__search',
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
      ];
      const text = `The document mentions ${tools.join(', ')}.`;
      const content =
        format === 'text'
          ? text
          : format === 'text-blocks'
            ? [{ type: 'text', text }]
            : tools.map((tool_name) => ({ type: 'tool_reference', tool_name }));
      expect(
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name: 'Acme Documents', status: 'pending' }],
            },
          },
          {
            payload: {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', id: 'lookup', name: 'ToolSearch' },
                  {
                    type: 'tool_use',
                    id: 'read',
                    name: 'mcp__Task_Board__read',
                  },
                ],
              },
            },
          },
          {
            payload: {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'lookup',
                    content: 'No matching tools.',
                  },
                  { type: 'tool_result', tool_use_id: 'read', content },
                  { type: 'tool_result', tool_use_id: 'unknown', content },
                ],
              },
            },
          },
        ])
      ).toMatchObject({
        observedToolCount: 2,
        observedAllowedTools: [],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        catalogComplete: false,
      });
    }
  );

  it('verifies actual tool exposure and refuses approval prompts', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    const event = (tools: string[]) => ({
      payload: { type: 'system', subtype: 'init', tools },
    });
    expect(
      verifyCloudConnectorEvents(plan, [event(['Read', 'mcp__Glean__search'])])
        .approvalRequests
    ).toBe(0);
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        event(['mcp__Glean__search', 'mcp__Glean__send']),
      ])
    ).toThrow('unexpected');
    expect(() => verifyCloudConnectorEvents(plan, [event([])])).toThrow(
      'missing'
    );
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        event(['mcp__Glean__search']),
        {
          payload: {
            type: 'control_request',
            request: { subtype: 'can_use_tool' },
          },
        },
      ])
    ).toThrow('approvals');
    const none = planCloudConnectors(snapshot, { servers: {} });
    expect(
      verifyCloudConnectorEvents(none, [event(['Read'])]).observedToolCount
    ).toBe(1);
    expect(() =>
      verifyCloudConnectorEvents(none, [event(['mcp__Jira__new_tool'])])
    ).toThrow('unexpected');
  });

  it('resolves mixed configurations and refuses unavailable, ambiguous, or disconnected selections', () => {
    expect(
      planCloudConnectors(snapshot, {
        servers: {
          Glean: { policy: 'read-only' },
          jira: { policy: 'read-only' },
        },
      }).allowedTools
    ).toEqual(['mcp__Glean__search', 'mcp__Jira__read']);
    const unavailable = structuredClone(snapshot);
    unavailable.servers[0]!.toolDiscoveryError = 'HTTP 401';
    unavailable.servers[0]!.tools = [];
    unavailable.permissions['glean:old-tool'] = true;
    expect(() => planCloudConnectors(unavailable, { servers: {} })).toThrow(
      'Cannot configure'
    );
    expect(() =>
      planCloudConnectors(unavailable, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('Cannot configure');
    unavailable.servers[0]!.connectionState = 'initiated';
    expect(
      planCloudConnectors(unavailable, { servers: {} }).patch['glean:old-tool']
    ).toBe(false);
    expect(() =>
      planCloudConnectors(unavailable, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('not connected');
    expect(() =>
      planCloudConnectors(snapshot, { servers: { glean: {}, Glean: {} } })
    ).toThrow('twice');
  });

  it('retains a recovery journal instead of overwriting concurrent edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-conflict-'));
    const state = structuredClone(snapshot);
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
        }
      },
    };
    try {
      const journal = join(dir, 'journal.json');
      const session = await configureCloudConnectors(
        io,
        { servers: {} },
        journal
      );
      state.permissions['glean:search'] = true;
      await expect(session.restore()).rejects.toThrow('concurrent edits');
      expect(state.permissions).toEqual({ 'glean:search': true });
      expect(JSON.parse(await readFile(journal, 'utf8')).version).toBe(2);
      delete state.permissions['glean:search'];
      await expect(recoverCloudConnectorSettings(io, journal)).resolves.toBe(
        true
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports allow-all, ask, tool overrides and inherited configuration independently', () => {
    const all = planCloudConnectors(snapshot, {
      servers: { glean: { policy: 'allow-all', tools: { send: 'block' } } },
    });
    expect(all.patch['glean:search-hash']).toBe(true);
    expect(all.patch['glean:unknown']).toBe(true);
    expect(all.patch['glean:send']).toBe(false);
    const ask = planCloudConnectors(snapshot, {
      default: 'inherit',
      failOnApproval: false,
      servers: { glean: { policy: 'ask' } },
    });
    expect(ask.patch['glean:search']).toBe(true);
    expect(ask.patch['glean:search-hash']).toBe(false);
    expect(ask.patch).not.toHaveProperty('jira:read');
    expect(() =>
      planCloudConnectors(snapshot, { servers: { glean: { policy: 'ask' } } })
    ).toThrow('failOnApproval');
    expect(() =>
      planCloudConnectors(snapshot, {
        servers: { missing: { policy: 'allow-all' } },
      })
    ).toThrow('unknown');
    expect(() =>
      planCloudConnectors(snapshot, {
        servers: { glean: { tools: { typo: 'allow' } } },
      })
    ).toThrow('Unknown tool');
    const restricted = structuredClone(snapshot);
    restricted.servers[0]!.tools[0]!.maxPermission = 'ask';
    expect(() =>
      planCloudConnectors(restricted, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('Organization policy');
  });

  it('applies both permissions and exactly restores absent keys while preserving unrelated concurrent changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-test-'));
    const state = structuredClone(snapshot);
    state.permissions['unrelated'] = true;
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch, expected) {
        for (const [key, value] of Object.entries(patch)) {
          expect(state.permissions[key] ?? null).toEqual(expected[key]);
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
        }
      },
    };
    try {
      const session = await configureCloudConnectors(
        io,
        { servers: { Glean: { policy: 'read-only' } } },
        join(dir, 'journal.json')
      );
      expect(state.permissions['glean:search-hash']).toBe(true);
      expect(state.permissions['glean:send']).toBe(false);
      state.permissions.unrelated = false;
      await session.restore();
      expect(state.permissions).toEqual({ unrelated: false });
      await expect(readFile(join(dir, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains unknown partial application failures without automatic rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-failure-'));
    const state = structuredClone(snapshot);
    let fail = true;
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch: PermissionPatch) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
          if (fail) {
            fail = false;
            throw new Error('connection dropped after partial write');
          }
        }
      },
    };
    try {
      await expect(
        configureCloudConnectors(io, { servers: {} }, join(dir, 'journal.json'))
      ).rejects.toThrow('connection dropped');
      expect(state.permissions).toEqual({ 'glean:search': false });
      expect(
        JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8'))
      ).toHaveProperty('pendingWrite.purpose', 'configure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('selects Glean read-only, explicitly approves reads, and blocks writes, unknowns and other servers', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    expect(plan.patch).toEqual({
      'glean:search': true,
      'glean:search-hash': true,
      'glean:send': false,
      'glean:send-hash': false,
      'glean:unknown': false,
      'glean:unknown-hash': false,
      'jira:read': false,
      'jira:read-hash': false,
    });
    expect(plan.allowedTools).toEqual(['mcp__Glean__search']);
  });
});
