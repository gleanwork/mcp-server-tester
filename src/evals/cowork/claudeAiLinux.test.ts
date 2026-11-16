import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type * as Os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coworkClaudeAi } from './claudeAi.js';
import { parseClaudeTranscript } from './transcript.js';
import type { CoworkDesktop } from './desktop.js';
import {
  COWORK_CLOUD_CONTROL_PROTOCOL,
  type CoworkCloudControlRequest,
  type CoworkCloudPreparation,
} from './cloudControlProtocol.js';

const host = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => host.home,
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => {
    throw new Error('Linux account wrapper must never run macOS commands.');
  }),
}));

const SERVER = {
  transport: 'http' as const,
  label: 'search',
  serverUrl: 'https://mcp.example.test/mcp',
};
const PROMPT = 'the exact authorized prompt';

describe('Linux claude.ai wrapper (offline base + private domain socket)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let server: Server;
  const sockets = new Set<Socket>();
  let base: CoworkDesktop;
  let preparation: CoworkCloudPreparation;
  let methods: string[];
  let rejectMethod: string | undefined;
  let dispose: (() => Promise<void>) | undefined;
  const actions: string[] = [];
  beforeEach(async () => {
    host.home = await mkdtemp('/tmp/mst-1p-worker-');
    methods = [];
    actions.length = 0;
    rejectMethod = undefined;
    dispose = undefined;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    preparation = {
      plan: {
        accountId: 'account',
        organizationId: 'org',
        patch: {},
        allowedTools: [],
        blockedTools: [],
        managedServers: [],
        serverDisplayNames: {},
        failOnApproval: true,
      },
      serverLabels: { Search: 'search' },
      remoteServerNames: ['Search'],
      effectiveConnectors: {},
      servers: [SERVER],
      model: 'exact-model',
    };
    base = {
      dataDirectory: () => join(host.home, 'native'),
      prepare: vi.fn(async () => {
        actions.push('preflight');
        return {
          app: {
            name: 'Claude',
            version: 'linux-test',
            source: 'installed' as const,
          },
          restart: vi.fn(async () => {
            actions.push('restart');
          }),
          dispose: vi.fn(async () => {
            actions.push('base-dispose');
          }),
        };
      }),
      recover: vi.fn(async () => undefined),
      diagnose: vi.fn(async () => {
        actions.push('diagnose');
      }),
      reset: vi.fn(async () => {
        actions.push('reset');
      }),
      submit: vi.fn(async () => {
        actions.push('submit');
        return { status: 'submitted' as const, action_count: 1 };
      }),
      handleHitl: vi.fn(async () => ({
        status: 'hitl_checked' as const,
        action_count: 1,
      })),
    };
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const request = JSON.parse(
            pending.slice(0, newline)
          ) as CoworkCloudControlRequest;
          pending = pending.slice(newline + 1);
          methods.push(request.method);
          actions.push(request.method);
          const result =
            request.method === 'prepare'
              ? preparation
              : request.method === 'listSessions'
                ? []
                : null;
          const outcome =
            request.method === rejectMethod
              ? {
                  ok: false,
                  error: 'Source task is still pending; journal retained.',
                }
              : { ok: true, result };
          socket.write(
            `${JSON.stringify({ protocol: COWORK_CLOUD_CONTROL_PROTOCOL, id: request.id, ...outcome })}\n`
          );
        }
      });
    });
    const path = join(host.home, 'control.sock');
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await chmod(path, 0o600);
  });
  afterEach(async () => {
    rejectMethod = undefined;
    await dispose?.().catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.defineProperty(process, 'platform', platform);
    await rm(host.home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function desktop() {
    return coworkClaudeAi(base, { servers: [SERVER] });
  }
  async function prepared(desktop: CoworkDesktop) {
    const session = await desktop.prepare({
      evalConfig: { name: 'test', datasets: [] },
      env: { MST_COWORK_CLOUD_CONTROL_SOCKET: join(host.home, 'control.sock') },
      model: 'exact-model',
    });
    dispose = session.dispose;
    return session;
  }

  it('delegates Linux preflight/lifecycle, journals before one submit, and gates reset/restart on source completion', async () => {
    const wrapper = desktop();
    const session = await prepared(wrapper);
    expect(session.app?.version).toBe('linux-test');
    expect(base.prepare).toHaveBeenCalledOnce();
    expect(actions.slice(0, 2)).toEqual(['preflight', 'prepare']);
    await wrapper.diagnose!({
      dir: host.home,
      dataDir: wrapper.dataDirectory({}),
      env: {},
    });
    expect(base.diagnose).toHaveBeenCalledOnce();
    expect(wrapper.mcpServerLabels?.()).toEqual({ Search: 'search' });
    await wrapper.submit(PROMPT, {
      deadlineAt: Date.now() + 10_000,
      targetModel: 'exact-model',
    });
    expect(actions.indexOf('beginTask')).toBeLessThan(
      actions.indexOf('submit')
    );
    expect(base.submit).toHaveBeenCalledExactlyOnceWith(PROMPT, {
      deadlineAt: expect.any(Number),
      targetModel: 'exact-model',
    });
    rejectMethod = 'confirmTaskComplete';
    await expect(
      wrapper.reset!({ deadlineAt: Date.now() + 1_000 })
    ).rejects.toThrow(/still pending/);
    await expect(session.restart!()).rejects.toThrow(/still pending/);
    expect(actions).not.toContain('reset');
    expect(actions).not.toContain('restart');
    rejectMethod = undefined;
    await wrapper.reset!({ deadlineAt: Date.now() + 1_000 });
    await session.restart!();
    expect(actions).toContain('reset');
    expect(actions).toContain('restart');
    await wrapper.handleHitl({ deadlineAt: Date.now() + 1_000 });
    expect(base.handleHitl).not.toHaveBeenCalled();
    await session.dispose();
    dispose = undefined;
    expect(methods.at(-1)).toBe('restore');
    expect(actions.at(-1)).toBe('base-dispose');
  }, 10_000);

  it('uses the same exact native binding and writes the existing connector-policy receipt', async () => {
    const wrapper = desktop();
    await prepared(wrapper);
    await wrapper.submit(PROMPT, { deadlineAt: Date.now() + 10_000 });
    const dir = join(host.home, 'trial');
    await mkdir(dir);
    await writeFile(
      join(dir, 'audit.jsonl'),
      `${JSON.stringify({ type: 'system', subtype: 'init', tools: [] })}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', is_error: false })}\n`
    );
    const transcript = await parseClaudeTranscript({
      id: 'local_cse_owned',
      sessionDir: dir,
      metadataPath: join(dir, 'metadata.json'),
      metadata: { sessionId: 'cse_owned', initialMessage: PROMPT },
      statMtimeMs: 0,
    });
    await expect(
      wrapper.bindSession!({ ...transcript, binding: undefined })
    ).rejects.toThrow(/exact submitted prompt/);
    await wrapper.bindSession!({
      ...transcript,
      binding: { kind: 'exact-initial-prompt' },
    });
    await wrapper.validateTranscript!(transcript);
    expect(methods).toContain('bindTask');
    expect(methods).toContain('verify');
    const { readFile } = await import('node:fs/promises');
    expect(
      JSON.parse(await readFile(join(dir, 'connector-policy.json'), 'utf8'))
    ).toMatchObject({
      mode: 'first-party',
      verification: 'passed',
      settingsVerified: true,
    });
  }, 10_000);

  it('rejects managed/gateway preflight before source account mutations', async () => {
    base.prepare = vi.fn(async () => {
      throw new Error('Unexpected managed/gateway profile.');
    });
    const wrapper = desktop();
    await expect(prepared(wrapper)).rejects.toThrow(/managed\/gateway/);
    expect(methods).toEqual([]);
    expect(base.submit).not.toHaveBeenCalled();
    await wrapper.dispose!();
  });

  it('rejects a model/policy mismatch before UI submission and reports retained source state', async () => {
    preparation.model = 'wrong-model';
    const wrapper = desktop();
    await expect(prepared(wrapper)).rejects.toThrow(
      /immutable source-authorized batch/
    );
    expect(methods).toEqual(['prepare']);
    expect(base.submit).not.toHaveBeenCalled();
    await expect(wrapper.dispose!()).rejects.toThrow(
      /source recovery state must be retained/
    );
  });
});
