import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreCoworkConnectorsCommand } from '../../cli/commands/cowork/index.js';
import { claimDesktopLease } from '../desktopBatch.js';
import { coworkDesktopLease } from './desktopLease.js';
import { restoreCoworkConnectors } from './restoreConnectors.js';

const host = vi.hoisted(() => ({
  home: '',
  nativeCommands: [] as string[],
  beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
  afterUnlink: undefined as ((path: string) => Promise<void>) | undefined,
}));

// Only external boundaries are substituted. The real CLI handler, desktop
// lease, restoration primitive and journal logic run together in every test.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof Os>();
  const homedir = () => host.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      await host.beforeLstat?.(String(path));
      return actual.lstat(path);
    },
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      await actual.unlink(path);
      await host.afterUnlink?.(String(path));
    },
  };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    execFile: vi.fn((file: string) => {
      host.nativeCommands.push(file);
      throw new Error('Connector recovery must not run native commands.');
    }),
  };
});

const DEAD_PID = 2_000_000_000;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

interface PermissionState {
  accountId: string;
  organizationId: string;
  permissions: Record<string, boolean>;
}
interface PageArgument {
  action: string;
  sessionId?: string;
  identity?: { accountId: string; organizationId: string };
  patch?: Record<string, boolean | null>;
  expected?: Record<string, boolean | null>;
}

interface CloudEvent {
  source?: string;
  created_at?: string;
  payload: Record<string, unknown>;
}

/** A real loopback HTTP/WebSocket CDP endpoint; no browser or account exists. */
async function fakeChrome(
  state: PermissionState,
  {
    observe = async () => {},
    sessions = {},
  }: {
    observe?: (action: PageArgument) => Promise<void>;
    /** The claude.ai session events the page program reads, by `cse_` ID. */
    sessions?: Record<string, CloudEvent[]>;
  } = {}
) {
  const actions: PageArgument[] = [];
  const sockets = new Set<Duplex>();
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port.');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify([
        {
          type: 'page',
          url: 'https://claude.ai/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/recovery`,
        },
      ])
    );
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') throw new Error('No WebSocket key.');
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0f;
        let length = pending[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (pending[1]! & 0x80) !== 0;
        const start = offset + (masked ? 4 : 0);
        if (pending.length < start + length) return;
        const data = Buffer.from(pending.subarray(start, start + length));
        if (masked)
          for (let index = 0; index < data.length; index++)
            data[index] = data[index]! ^ pending[offset + (index % 4)]!;
        pending = pending.subarray(start + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode !== 1) continue;
        void reply(data.toString()).catch((error: unknown) => {
          errors.push(error);
          socket.destroy();
        });
      }
    });
    async function reply(text: string): Promise<void> {
      const request = JSON.parse(text) as {
        id: number;
        method: string;
        params: { expression: string };
      };
      expect(request.method).toBe('Runtime.evaluate');
      const expression = request.params.expression;
      const argument = JSON.parse(
        expression.slice(expression.lastIndexOf(')(') + 2, -1)
      ) as PageArgument;
      actions.push(argument);
      await observe(argument);
      let value: unknown;
      if (argument.action === 'permissions') {
        value = { status: 200, state };
      } else if (argument.action === 'events') {
        const id = argument.sessionId ?? '';
        value = Object.hasOwn(sessions, id)
          ? { status: 200, events: sessions[id] }
          : { status: 404 };
      } else if (argument.action === 'patch-permissions') {
        expect(argument.identity).toMatchObject({
          accountId: state.accountId,
          organizationId: state.organizationId,
        });
        for (const [key, applied] of Object.entries(argument.patch ?? {})) {
          expect(state.permissions[key] ?? null).toBe(argument.expected?.[key]);
          if (applied === null) delete state.permissions[key];
          else state.permissions[key] = applied;
        }
        value = { status: 200 };
      } else {
        throw new Error(
          `Recovery attempted non-recovery action ${argument.action}`
        );
      }
      const body = Buffer.from(
        JSON.stringify({
          id: request.id,
          result: { result: { value } },
        })
      );
      const header = Buffer.alloc(body.length < 126 ? 2 : 4);
      header[0] = 0x81;
      if (body.length < 126) header[1] = body.length;
      else {
        header[1] = 126;
        header.writeUInt16BE(body.length, 2);
      }
      socket.write(Buffer.concat([header, body]));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  return {
    env: { MST_CLAUDE_AI_DEBUG_PORT: String(address.port) },
    actions,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      expect(errors).toEqual([]);
    },
  };
}

function paths() {
  const lease = coworkDesktopLease('');
  return {
    lease,
    main: join(lease.directory, lease.file),
    guard: join(lease.directory, `${lease.file}.recovery`),
    journal: join(lease.directory, 'cowork-claude-ai-connectors.json'),
  };
}
async function writeOwner(pid = DEAD_PID, path = paths().main) {
  await mkdir(paths().lease.directory, { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ pid, startedAt: '2026-11-09T00:00:00.000Z' }),
    { mode: 0o600 }
  );
}
const ORIGINAL = { 'server:read': true, 'server:approval': null };
const APPLIED = { 'server:read': false, 'server:approval': false };

/**
 * A version 2 journal as preparation writes it. With no `pendingWrite` and no
 * `pendingTask` it is settled: every write's outcome is known and no task runs.
 */
async function writeJournal(fields: Record<string, unknown> = {}) {
  await mkdir(paths().lease.directory, { recursive: true });
  const text = JSON.stringify({
    version: 2,
    accountId: 'account',
    organizationId: 'organization',
    original: ORIGINAL,
    applied: APPLIED,
    ...fields,
  });
  await writeFile(paths().journal, text, { mode: 0o600 });
  return text;
}

const STARTED_AT = '2026-11-09T00:00:00.000Z';

/**
 * A Cowork task's session events: a prewarm setup message with its zero-turn
 * result, then the queried prompt. Only a result for the queried prompt ends
 * the task.
 */
function taskEvents(ended: boolean): CloudEvent[] {
  return [
    {
      source: 'client',
      created_at: '2026-11-09T00:00:01.000Z',
      payload: {
        type: 'user',
        uuid: 'message-setup',
        shouldQuery: false,
        message: { role: 'user', content: 'Prepare the workspace' },
      },
    },
    {
      created_at: '2026-11-09T00:00:02.000Z',
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        user_message_uuids: ['message-setup'],
      },
    },
    {
      source: 'client',
      created_at: '2026-11-09T00:00:03.000Z',
      payload: {
        type: 'user',
        uuid: 'message-query',
        message: { role: 'user', content: 'Find the Acme roadmap' },
      },
    },
    {
      created_at: '2026-11-09T00:00:04.000Z',
      payload: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Searching the Acme docs.' }],
        },
      },
    },
    ...(ended
      ? [
          {
            created_at: '2026-11-09T00:00:05.000Z',
            payload: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              num_turns: 2,
              result: 'The Acme roadmap is in the planning folder.',
              user_message_uuids: ['message-query'],
            },
          },
        ]
      : []),
  ];
}

/** The journal and both locks a refused restoration must leave behind. */
async function expectRetained(journal: string) {
  expect(await readFile(paths().journal, 'utf8')).toBe(journal);
  expect(JSON.parse(await readFile(paths().main, 'utf8'))).toMatchObject({
    pid: process.pid,
  });
  await expect(lstat(paths().guard)).rejects.toHaveProperty('code', 'ENOENT');
  // An ordinary eval cannot take the desktop until someone inspects it.
  await expect(
    claimDesktopLease({ name: 'Cowork', lease: paths().lease })
  ).rejects.toThrow('desktop is locked');
}
function state(): PermissionState {
  return {
    accountId: 'account',
    organizationId: 'organization',
    permissions: { 'server:read': false, 'server:approval': false },
  };
}

let chrome: Awaited<ReturnType<typeof fakeChrome>> | undefined;
beforeEach(async () => {
  host.nativeCommands = [];
  host.home = await mkdtemp(join(tmpdir(), 'mst-restore-connectors-'));
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === DEAD_PID)
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    return true;
  });
});
afterEach(async () => {
  host.afterUnlink = undefined;
  host.beforeLstat = undefined;
  try {
    await chrome?.close();
  } finally {
    chrome = undefined;
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(host.home, { recursive: true, force: true });
    expect(host.nativeCommands).toEqual([]);
  }
});

describe('restore-only Cowork connector recovery', () => {
  it.each(['linux', 'win32'])(
    'refuses %s before creating locks',
    async (os) => {
      Object.defineProperty(process, 'platform', { ...platform, value: os });
      await expect(restoreCoworkConnectors()).rejects.toThrow('macOS only');
      expect(await readdir(host.home)).toEqual([]);
    }
  );

  it('returns false without a journal or Chrome, and releases both locks', async () => {
    expect(
      await restoreCoworkConnectors({}, { MST_CLAUDE_AI_DEBUG_PORT: 'invalid' })
    ).toBe(false);
    expect(await readdir(paths().lease.directory)).toEqual([]);
  });

  it('requires explicit stale-lock recovery and preserves the journal', async () => {
    const journal = await writeJournal();
    await writeOwner();
    const owner = await readFile(paths().main, 'utf8');
    await expect(restoreCoworkConnectors()).rejects.toThrow(
      '--recover-stale-lock'
    );
    expect(await readFile(paths().main, 'utf8')).toBe(owner);
    expect(await readFile(paths().journal, 'utf8')).toBe(journal);
    expect(process.kill).not.toHaveBeenCalled();
    await expect(lstat(paths().guard)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('reclaims only a provably stopped owner and reports a missing journal', async () => {
    await writeOwner();
    expect(await restoreCoworkConnectors({ recoverStaleLock: true })).toBe(
      false
    );
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(DEAD_PID, 0);
    expect(await readdir(paths().lease.directory)).toEqual([]);
  });

  it('never steals a live main lease, even with explicit recovery', async () => {
    const lease = await claimDesktopLease({
      name: 'Cowork',
      lease: paths().lease,
    });
    const owner = await readFile(paths().main, 'utf8');
    try {
      await expect(
        restoreCoworkConnectors({ recoverStaleLock: true })
      ).rejects.toThrow(`PID ${process.pid} is live or its status is unknown`);
      expect(await readFile(paths().main, 'utf8')).toBe(owner);
    } finally {
      await lease.release(false);
    }
  });

  it.each(['EPERM', 'EACCES', 'EIO'])(
    'refuses unknown owner status %s',
    async (code) => {
      await writeOwner();
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('Unknown status'), { code });
      });
      const owner = await readFile(paths().main, 'utf8');
      await expect(
        restoreCoworkConnectors({ recoverStaleLock: true })
      ).rejects.toThrow('live or its status is unknown');
      expect(await readFile(paths().main, 'utf8')).toBe(owner);
    }
  );

  it.each([
    'not JSON',
    '{}',
    '{"pid":0,"startedAt":"2026-11-09"}',
    '{"pid":-1,"startedAt":"2026-11-09"}',
    '{"pid":1.5,"startedAt":"2026-11-09"}',
    '{"pid":"123","startedAt":"2026-11-09"}',
    '{"pid":2000000000}',
    '{"pid":2000000000,"startedAt":"unknown"}',
  ])('preserves an untrusted owner record %s', async (owner) => {
    await mkdir(paths().lease.directory, { recursive: true });
    await writeFile(paths().main, owner);
    await expect(
      restoreCoworkConnectors({ recoverStaleLock: true })
    ).rejects.toThrow('Inspect the lock and its owner manually');
    expect(await readFile(paths().main, 'utf8')).toBe(owner);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does not follow a main-lock symlink', async () => {
    const original = join(host.home, 'owner.json');
    await writeOwner(DEAD_PID, original);
    await symlink(original, paths().main);
    await expect(
      restoreCoworkConnectors({ recoverStaleLock: true })
    ).rejects.toThrow('could not be read safely');
    expect((await lstat(paths().main)).isSymbolicLink()).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('refuses a main lease replaced after owner inspection', async () => {
    await writeOwner();
    let replacement = '';
    host.beforeLstat = async (path) => {
      if (path !== paths().main) return;
      host.beforeLstat = undefined;
      await rm(path);
      await writeOwner(process.pid);
      replacement = await readFile(path, 'utf8');
    };
    await expect(
      restoreCoworkConnectors({ recoverStaleLock: true })
    ).rejects.toThrow('lock changed during inspection');
    expect(await readFile(paths().main, 'utf8')).toBe(replacement);
  });

  it.each(['live', 'dead', 'unknown'])(
    'never reclaims a %s recovery guard',
    async (kind) => {
      const journal = await writeJournal();
      await writeOwner();
      if (kind === 'unknown')
        await writeFile(paths().guard, 'unreadable owner');
      else
        await writeOwner(
          kind === 'live' ? process.pid : DEAD_PID,
          paths().guard
        );
      const main = await readFile(paths().main, 'utf8');
      const guard = await readFile(paths().guard, 'utf8');
      await expect(
        restoreCoworkConnectors({ recoverStaleLock: true })
      ).rejects.toThrow(
        '--recover-stale-lock does not reclaim recovery guards'
      );
      expect(await readFile(paths().guard, 'utf8')).toBe(guard);
      expect(await readFile(paths().main, 'utf8')).toBe(main);
      expect(await readFile(paths().journal, 'utf8')).toBe(journal);
      expect(process.kill).not.toHaveBeenCalled();
    }
  );

  it('aborts without account mutation when an eval wins after stale unlink', async () => {
    const journal = await writeJournal();
    await writeOwner();
    let winner: Awaited<ReturnType<typeof claimDesktopLease>> | undefined;
    let freshOwner = '';
    host.afterUnlink = async (path) => {
      if (path !== paths().main) return;
      host.afterUnlink = undefined;
      winner = await claimDesktopLease({
        name: 'Cowork',
        lease: paths().lease,
      });
      freshOwner = await readFile(path, 'utf8');
      // A second recovery must not remove the normal eval's fresh lease.
      await expect(
        restoreCoworkConnectors({ recoverStaleLock: true })
      ).rejects.toThrow('does not reclaim recovery guards');
    };
    try {
      await expect(
        restoreCoworkConnectors(
          { recoverStaleLock: true },
          { MST_CLAUDE_AI_DEBUG_PORT: 'invalid' }
        )
      ).rejects.toThrow('desktop is locked');
      expect(await readFile(paths().main, 'utf8')).toBe(freshOwner);
      expect(await readFile(paths().journal, 'utf8')).toBe(journal);
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(DEAD_PID, 0);
    } finally {
      await winner?.release(false);
    }
  });

  it('restores through actual fake CDP under the shared lease, without native work', async () => {
    await writeJournal();
    await writeOwner();
    const current = state();
    chrome = await fakeChrome(current, {
      async observe() {
        const owner = JSON.parse(await readFile(paths().main, 'utf8')) as {
          pid: number;
        };
        expect(owner.pid).toBe(process.pid);
        await expect(lstat(paths().guard)).resolves.toBeDefined();
      },
    });
    expect(
      await restoreCoworkConnectors({ recoverStaleLock: true }, chrome.env)
    ).toBe(true);
    expect(current.permissions).toEqual({ 'server:read': true });
    expect(chrome.actions.map((action) => action.action)).toEqual([
      'permissions',
      'patch-permissions',
      'permissions',
      'permissions',
    ]);
    expect(await readdir(paths().lease.directory)).toEqual([]);
  });

  it('clears an already-restored journal without permission writes', async () => {
    await writeJournal();
    const current = state();
    current.permissions = { 'server:read': true };
    chrome = await fakeChrome(current);
    expect(await restoreCoworkConnectors({}, chrome.env)).toBe(true);
    expect(chrome.actions.map((action) => action.action)).toEqual([
      'permissions',
      'permissions',
    ]);
    expect(await readdir(paths().lease.directory)).toEqual([]);
  });

  it('retains an invalid journal and main lock without contacting Chrome', async () => {
    await mkdir(paths().lease.directory, { recursive: true });
    await writeFile(paths().journal, 'not a valid journal');
    await expect(
      restoreCoworkConnectors({}, { MST_CLAUDE_AI_DEBUG_PORT: 'invalid' })
    ).rejects.toThrow('recovery journal and desktop lock');
    expect(await readFile(paths().journal, 'utf8')).toBe('not a valid journal');
    await expect(lstat(paths().main)).resolves.toBeDefined();
    await expect(lstat(paths().guard)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('retains the journal and main lock on Chrome/configuration failure', async () => {
    const journal = await writeJournal();
    await expect(
      restoreCoworkConnectors({}, { MST_CLAUDE_AI_DEBUG_PORT: 'invalid' })
    ).rejects.toThrow('MST_CLAUDE_AI_DEBUG_PORT is not a port');
    expect(await readFile(paths().journal, 'utf8')).toBe(journal);
    expect(JSON.parse(await readFile(paths().main, 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    await expect(lstat(paths().guard)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('retains guarded failure evidence for an account mismatch without writes', async () => {
    const journal = await writeJournal();
    chrome = await fakeChrome({ ...state(), accountId: 'another-account' });
    await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
      'Claude account or organization changed'
    );
    expect(chrome.actions.map((action) => action.action)).toEqual([
      'permissions',
    ]);
    expect(await readFile(paths().journal, 'utf8')).toBe(journal);
    await expect(lstat(paths().main)).resolves.toBeDefined();
  });

  it('does not overwrite concurrent account edits', async () => {
    const journal = await writeJournal();
    const current = state();
    delete current.permissions['server:read'];
    delete current.permissions['server:approval'];
    chrome = await fakeChrome(current);
    await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
      'concurrent edits'
    );
    expect(chrome.actions.map((action) => action.action)).toEqual([
      'permissions',
    ]);
    expect(await readFile(paths().journal, 'utf8')).toBe(journal);
    expect(current.permissions).toEqual({});
    await expect(lstat(paths().main)).resolves.toBeDefined();
  });

  it.each([
    ['configure', false],
    ['restore', true],
  ] as const)(
    'refuses an unresolved %s write even when permissions read as original (stale-lock recovery: %s)',
    async (purpose, recoverStaleLock) => {
      const journal = await writeJournal({
        pendingWrite:
          purpose === 'configure'
            ? { purpose, patch: APPLIED, expected: ORIGINAL }
            : { purpose, patch: ORIGINAL, expected: APPLIED },
      });
      if (recoverStaleLock) await writeOwner();
      // The account already shows the original values; that does not prove
      // the dispatched write will never commit.
      const current = state();
      current.permissions = { 'server:read': true };
      chrome = await fakeChrome(current);
      await expect(
        restoreCoworkConnectors({ recoverStaleLock }, chrome.env)
      ).rejects.toThrow(/retained for inspection.*unknown/is);
      expect(chrome.actions).toEqual([]);
      expect(current.permissions).toEqual({ 'server:read': true });
      await expectRetained(journal);
      // Retrying, even with the flag, cannot clear it: the retained lock's
      // owner is this live process, not a provably stopped one.
      await expect(
        restoreCoworkConnectors({ recoverStaleLock: true }, chrome.env)
      ).rejects.toThrow(`PID ${process.pid} is live or its status is unknown`);
      expect(chrome.actions).toEqual([]);
      await expectRetained(journal);
    }
  );

  it('refuses a version 1 journal, which cannot prove write or task outcomes', async () => {
    const journal = await writeJournal({ version: 1 });
    const current = state();
    chrome = await fakeChrome(current);
    await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
      /retained for inspection.*version 1/is
    );
    expect(chrome.actions).toEqual([]);
    expect(current.permissions).toEqual(state().permissions);
    await expectRetained(journal);
  });

  it('refuses a pending task that never bound a session', async () => {
    const journal = await writeJournal({
      pendingTask: { startedAt: STARTED_AT },
    });
    const current = state();
    chrome = await fakeChrome(current);
    await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
      /retained for inspection.*unbound/is
    );
    expect(
      chrome.actions.filter((action) => action.action !== 'permissions')
    ).toEqual([]);
    expect(current.permissions).toEqual(state().permissions);
    await expectRetained(journal);
  });

  it.each([
    [
      'is still running after its prewarm result',
      { cse_acme_trial: taskEvents(false) },
    ],
    ['has no session events', {}],
  ])(
    'refuses a bound task that %s',
    async (_case, sessions: Record<string, CloudEvent[]>) => {
      const journal = await writeJournal({
        pendingTask: { startedAt: STARTED_AT, sessionId: 'cse_acme_trial' },
      });
      const current = state();
      chrome = await fakeChrome(current, { sessions });
      await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
        'retained for inspection'
      );
      expect(chrome.actions).toContainEqual(
        expect.objectContaining({
          action: 'events',
          sessionId: 'cse_acme_trial',
        })
      );
      expect(chrome.actions.map((action) => action.action)).not.toContain(
        'patch-permissions'
      );
      expect(current.permissions).toEqual(state().permissions);
      await expectRetained(journal);
    }
  );

  it('checks the account before reading a bound task', async () => {
    const journal = await writeJournal({
      pendingTask: { startedAt: STARTED_AT, sessionId: 'cse_acme_trial' },
    });
    chrome = await fakeChrome(
      { ...state(), accountId: 'another-account' },
      { sessions: { cse_acme_trial: taskEvents(true) } }
    );
    await expect(restoreCoworkConnectors({}, chrome.env)).rejects.toThrow(
      'Claude account or organization changed'
    );
    expect(chrome.actions.map((action) => action.action)).toEqual([
      'permissions',
    ]);
    await expectRetained(journal);
  });

  it('restores once claude.ai shows the bound task ended', async () => {
    await writeJournal({
      pendingTask: { startedAt: STARTED_AT, sessionId: 'cse_acme_trial' },
    });
    const current = state();
    chrome = await fakeChrome(current, {
      sessions: { cse_acme_trial: taskEvents(true) },
    });
    expect(await restoreCoworkConnectors({}, chrome.env)).toBe(true);
    expect(current.permissions).toEqual({ 'server:read': true });
    const actions = chrome.actions.map((action) => action.action);
    expect(actions).toContain('events');
    expect(actions.indexOf('events')).toBeLessThan(
      actions.indexOf('patch-permissions')
    );
    expect(
      chrome.actions.filter((action) => action.action === 'events')
    ).toEqual([expect.objectContaining({ sessionId: 'cse_acme_trial' })]);
    expect(await readdir(paths().lease.directory)).toEqual([]);
  });

  it('prints the actual missing-journal and restored outcomes in the CLI handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await restoreCoworkConnectorsCommand({});
    expect(log).toHaveBeenLastCalledWith(
      'No Claude account connector recovery journal was found; no settings were changed.'
    );
    await writeJournal();
    chrome = await fakeChrome(state());
    vi.stubEnv('MST_CLAUDE_AI_DEBUG_PORT', chrome.env.MST_CLAUDE_AI_DEBUG_PORT);
    await restoreCoworkConnectorsCommand({});
    expect(log).toHaveBeenLastCalledWith(
      'Restored Claude account connector settings from the recovery journal.'
    );
  });
});
