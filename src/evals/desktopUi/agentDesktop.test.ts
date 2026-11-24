import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDesktopError,
  agentDesktop,
  agentDesktopBinary,
  type AgentDesktopCall,
} from './agentDesktop.js';

// The real lookup, which tests/vitest.setup.ts hides from every other test.
// Each test here names where it looks, and none runs what it finds.
vi.unmock('./agentDesktop.js');

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function temporary(): Promise<string> {
  // Resolved: a package is found by its real path (macOS links /var).
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'mst-agent-desktop-test-'))
  );
  directories.push(directory);
  return directory;
}

/** A client whose CLI prints `replies` in order, and the calls it received. */
function scripted(replies: unknown[], deadlineAt = Date.now() + 60_000) {
  const calls: AgentDesktopCall[] = [];
  const desktop = agentDesktop({
    binary: '/nonexistent/agent-desktop',
    deadlineAt,
    run: async (call) => {
      calls.push(call);
      const reply = replies.shift();
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  });
  return { desktop, calls };
}

describe('agentDesktop', () => {
  it('reads a window with the deepest tree and a timeout inside the process limit', async () => {
    const { desktop, calls } = scripted([
      {
        ok: true,
        data: {
          complete: true,
          tree: {
            role: 'window',
            name: 'Claude',
            children: [
              { role: 'button', name: 'Start task', ref_id: '@s1:e1' },
              { role: 'statictext', name: null, states: null, value: 'x' },
            ],
          },
        },
      },
    ]);
    const snapshot = await desktop.snapshot({ id: 'w-7', app: 'An App' });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tree.children?.[0]).toMatchObject({
      role: 'button',
      ref_id: '@s1:e1',
    });
    const [call] = calls;
    // Scoped to the app: agent-desktop then settles only its windows.
    expect(call!.args.slice(0, 7)).toEqual([
      'snapshot',
      '--app',
      'An App',
      '--window-id',
      'w-7',
      '--max-depth',
      '50',
    ]);
    expect(call!.args[7]).toBe('--timeout-ms');
    expect(Number(call!.args[8])).toBeGreaterThan(0);
    expect(Number(call!.args[8])).toBeLessThan(call!.timeoutMs);
  });

  it('reports a read agent-desktop could not finish as incomplete', async () => {
    const { desktop } = scripted([
      { ok: true, data: { complete: false, tree: { role: 'window' } } },
    ]);
    expect((await desktop.snapshot({ id: 'w-1', app: 'A' })).complete).toBe(
      false
    );
  });

  it('sends the text of set-value on stdin, never as an argument', async () => {
    const { desktop, calls } = scripted([{ ok: true, data: {} }]);
    await desktop.setValue('@s1:e2', 'a "quoted"\nprompt --flag');
    expect(calls).toEqual([
      {
        args: ['set-value', '@s1:e2', '--stdin'],
        stdin: 'a "quoted"\nprompt --flag',
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it('puts clipboard text on stdin, and sends focus and a key combo as physical input', async () => {
    const { desktop, calls } = scripted([
      { ok: true, data: {} },
      { ok: true, data: {} },
      { ok: true, data: {} },
    ]);
    await desktop.clipboardSet('line one\nline two');
    await desktop.focus('@s1:e2');
    await desktop.press('ctrl+v');
    expect(calls).toEqual([
      {
        args: ['clipboard-set', '--stdin'],
        stdin: 'line one\nline two',
        timeoutMs: expect.any(Number),
      },
      {
        args: ['--headed', 'focus', '@s1:e2'],
        stdin: undefined,
        timeoutMs: expect.any(Number),
      },
      {
        args: ['--headed', 'press', 'ctrl+v'],
        stdin: undefined,
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it('runs each read and action as one command', async () => {
    const { desktop, calls } = scripted([
      { ok: true, data: {} },
      { ok: true, data: {} },
      { ok: true, data: { property: 'value', value: 'draft' } },
      { ok: true, data: { property: 'value', value: null } },
      {
        ok: true,
        data: { permissions: { accessibility: { state: 'denied' } } },
      },
      {
        ok: true,
        data: [
          { id: 'w-1', pid: 10, accessible: true, visible: false, title: 't' },
        ],
      },
      { ok: true, data: [] },
      { ok: true, data: { version: '1.3.1', permissions: {} } },
      {
        ok: true,
        data: { apps: [{ name: 'Finder', pid: 7, bundle_id: 'x' }] },
      },
    ]);
    await desktop.click('@s1:e1');
    await desktop.scrollTo('@s1:e1');
    expect(await desktop.value('@s1:e3')).toBe('draft');
    expect(await desktop.value('@s1:e3')).toBeNull();
    expect(await desktop.accessibility()).toBe('denied');
    expect(await desktop.windows()).toEqual([
      { id: 'w-1', pid: 10, accessible: true, visible: false, title: 't' },
    ]);
    expect(await desktop.windows('Finder')).toEqual([]);
    expect(await desktop.version()).toBe('1.3.1');
    expect(await desktop.apps()).toEqual([
      { name: 'Finder', pid: 7, bundle_id: 'x' },
    ]);
    expect(calls.map((call) => call.args)).toEqual([
      ['click', '@s1:e1'],
      ['scroll-to', '@s1:e1'],
      ['get', '@s1:e3', '--property', 'value'],
      ['get', '@s1:e3', '--property', 'value'],
      ['status'],
      ['list-windows'],
      ['list-windows', '--app', 'Finder'],
      ['status'],
      ['list-apps'],
    ]);
  });

  it("keeps agent-desktop's code, kind and delivery verdict on a failure", async () => {
    const { desktop } = scripted([
      {
        ok: false,
        error: {
          code: 'ACTION_FAILED',
          message: 'Post-action state does not match the requested change',
          details: { kind: 'post_action_verification' },
          disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
        },
      },
      {
        ok: false,
        error: {
          code: 'STALE_REF',
          disposition: { delivery: 'not_delivered', retry: 'safe' },
        },
      },
      { ok: false, error: { code: 'TIMEOUT' } },
    ]);
    const failure = async () => {
      try {
        await desktop.click('@s1:e1');
      } catch (error) {
        return error as AgentDesktopError;
      }
      throw new Error('Expected a rejection.');
    };
    const unverified = await failure();
    expect(unverified).toBeInstanceOf(AgentDesktopError);
    expect(unverified).toMatchObject({
      code: 'ACTION_FAILED',
      kind: 'post_action_verification',
      delivery: 'delivered_unverified',
      mayHaveActed: true,
    });
    // No raw message: it can carry what the app showed.
    expect(unverified.message).toBe('ACTION_FAILED (post_action_verification)');
    expect(await failure()).toMatchObject({
      code: 'STALE_REF',
      mayHaveActed: false,
    });
    // Without a verdict, an action may have reached the app.
    expect(await failure()).toMatchObject({
      code: 'TIMEOUT',
      mayHaveActed: true,
    });
  });

  it.each([
    ['nothing', ''],
    ['text that is not JSON', 'Segmentation fault'],
    ['JSON that is not an envelope', '{"data":{}}'],
    ['a failure with no error', '{"ok":false}'],
  ])('fails with NO_REPLY when the process printed %s', async (_name, out) => {
    const { desktop } = scripted([out]);
    await expect(desktop.click('@s1:e1')).rejects.toMatchObject({
      code: 'NO_REPLY',
    });
  });

  it('fails with NO_REPLY when a successful reply has an unknown shape', async () => {
    const { desktop } = scripted([
      { ok: true, data: { tree: 'not a tree' } },
      { ok: true, data: { windows: [] } },
    ]);
    await expect(
      desktop.snapshot({ id: 'w-1', app: 'A' })
    ).rejects.toMatchObject({
      code: 'NO_REPLY',
    });
    await expect(desktop.windows()).rejects.toMatchObject({ code: 'NO_REPLY' });
  });

  it('runs nothing after its deadline', async () => {
    const { desktop, calls } = scripted([], Date.now() - 1);
    await expect(desktop.click('@s1:e1')).rejects.toMatchObject({
      code: 'TIMEOUT',
      mayHaveActed: false,
    });
    expect(calls).toEqual([]);
  });

  it('caps one call at the time left before the deadline', async () => {
    const { desktop, calls } = scripted(
      [{ ok: true, data: {} }],
      Date.now() + 2_000
    );
    await desktop.click('@s1:e1');
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(2_000);
  });
});

describe('the agent-desktop process', () => {
  async function fakeBinary(script: string): Promise<string> {
    const file = join(await temporary(), 'agent-desktop');
    await writeFile(file, `#!${process.execPath}\n${script}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it('gets stdin and its own settings, and none of the eval secrets', async () => {
    const binary = await fakeBinary(`
      let input = '';
      process.stdin.on('data', (chunk) => (input += chunk));
      process.stdin.on('end', () => {
        const state = JSON.stringify({
          args: process.argv.slice(2),
          input,
          env: Object.keys(process.env).sort(),
          home: process.env.AGENT_DESKTOP_HOME,
        });
        process.stdout.write(JSON.stringify({ ok: true, data: { value: state } }));
      });
    `);
    const desktop = agentDesktop({
      binary,
      deadlineAt: Date.now() + 30_000,
      env: {
        HOME: '/Users/someone',
        PATH: process.env.PATH,
        AGENT_DESKTOP_HOME: '/private/state',
        ANTHROPIC_API_KEY: 'secret',
        GLEAN_API_TOKEN: 'secret',
      },
    });
    const state = JSON.parse((await desktop.value('@s1:e1'))!);
    expect(state.args).toEqual(['get', '@s1:e1', '--property', 'value']);
    expect(state.input).toBe('');
    expect(state.home).toBe('/private/state');
    expect(state.env).toContain('HOME');
    expect(state.env).not.toContain('ANTHROPIC_API_KEY');
    expect(state.env).not.toContain('GLEAN_API_TOKEN');
  });

  it('reads the envelope of a command that exits with a failure', async () => {
    const binary = await fakeBinary(`
      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'PERM_DENIED' } }));
      process.exitCode = 1;
    `);
    const desktop = agentDesktop({ binary, deadlineAt: Date.now() + 30_000 });
    await expect(desktop.windows()).rejects.toMatchObject({
      code: 'PERM_DENIED',
    });
  });

  it('stops a command that outlives the deadline and reports no reply', async () => {
    const binary = await fakeBinary('setTimeout(() => {}, 60_000);');
    const desktop = agentDesktop({ binary, deadlineAt: Date.now() + 400 });
    const started = Date.now();
    await expect(desktop.windows()).rejects.toMatchObject({ code: 'NO_REPLY' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports no reply when the executable is missing', async () => {
    const desktop = agentDesktop({
      binary: join(await temporary(), 'missing'),
      deadlineAt: Date.now() + 30_000,
    });
    await expect(desktop.windows()).rejects.toMatchObject({ code: 'NO_REPLY' });
  });
});

describe('agentDesktopBinary', () => {
  async function project(bin: unknown, executable = true): Promise<string> {
    const root = await temporary();
    const directory = join(root, 'node_modules', 'agent-desktop');
    await mkdir(join(directory, 'bin'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'agent-desktop', version: '1.3.1', bin })
    );
    if (executable)
      await writeFile(join(directory, 'bin', 'agent-desktop'), '');
    await writeFile(join(root, 'package.json'), '{}');
    return root;
  }

  it("finds the installed package's executable from a project", async () => {
    const root = await project({ 'agent-desktop': 'bin/agent-desktop' });
    expect(agentDesktopBinary([join(root, 'package.json')])).toBe(
      join(root, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop')
    );
  });

  it('accepts a package whose bin is one path', async () => {
    const root = await project('bin/agent-desktop');
    expect(agentDesktopBinary([join(root, 'package.json')])).toBe(
      join(root, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop')
    );
  });

  it('tries each place in order', async () => {
    const empty = await temporary();
    await writeFile(join(empty, 'package.json'), '{}');
    const root = await project({ 'agent-desktop': 'bin/agent-desktop' });
    expect(
      agentDesktopBinary([
        join(empty, 'package.json'),
        join(root, 'package.json'),
      ])
    ).toContain(root);
  });

  it.each([
    ['is not installed', undefined],
    ['names no executable', {}],
    [
      'has not downloaded its executable',
      { 'agent-desktop': 'bin/agent-desktop' },
    ],
  ])('is undefined when the package %s', async (name, bin) => {
    const root =
      bin === undefined
        ? await temporary()
        : await project(bin, !name.includes('downloaded'));
    if (bin === undefined) await writeFile(join(root, 'package.json'), '{}');
    expect(agentDesktopBinary([join(root, 'package.json')])).toBeUndefined();
  });
});
