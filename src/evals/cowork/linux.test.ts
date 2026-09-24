import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { coworkPluginSettingsMatch, linuxCoworkPlatform } from './linux.js';
import type { HostPlugin } from '../hostPlugins.js';
import { CoworkDriverError, CoworkHitlBudgetError } from './driver.js';
import type { EvalManifest } from '../evalManifest.js';

const child = vi.hoisted(() => ({
  exec: vi.fn(),
  payloads: [] as string[],
  responses: [] as Array<{ failed?: boolean; value?: unknown }>,
}));
vi.mock('node:child_process', () => ({ execFile: child.exec }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
let directory: string;
const session = {
  DISPLAY: ':1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake/session',
  MST_COWORK_URL_OPENER: '/prepared/open-url',
  ANTHROPIC_API_KEY: 'do-not-forward-secret',
};
const options = () => ({ deadlineAt: Date.now() + 10000, env: session });
const manifest: EvalManifest = {
  name: 'linux-contract',
  datasets: [],
  host: { type: 'cowork', options: { computerUseProvider: 'linux-desktop' } },
  servers: [
    {
      transport: 'http',
      label: 'glean',
      serverUrl: 'https://example.com/eval',
    },
  ],
};
const settings = {
  inferenceModels: [{ name: 'test-model' }],
  managedMcpServers: [
    { name: 'glean', transport: 'http', url: 'https://example.com/eval' },
  ],
  allowManagedMcpServersOnly: true,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'linux-driver-test-'));
  child.exec.mockReset();
  child.payloads.length = 0;
  child.responses.length = 0;
  child.exec.mockImplementation((_python, args, _options, callback) => ({
    stdin: {
      on: vi.fn(),
      end: (payload: string) => {
        child.payloads.push(payload);
        const response = child.responses.shift();
        const mode = args[args.indexOf('--mode') + 1];
        callback(
          response?.failed ? new Error('secret child diagnostic') : null,
          JSON.stringify(
            response?.value ?? {
              status:
                mode === 'probe'
                  ? 'ready'
                  : mode === 'submit'
                    ? 'submitted'
                    : 'hitl_checked',
              action_count: 1,
              duration_ms: 1,
            }
          )
        );
      },
    },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function prepare(value: unknown = settings, plugins?: HostPlugin[]) {
  const file = join(directory, 'settings.json');
  await writeFile(file, JSON.stringify(value));
  return linuxCoworkPlatform.prepare({
    manifest,
    model: 'test-model',
    env: { ...session, MST_COWORK_SETTINGS_FILE: file },
    ...(plugins ? { plugins } : {}),
  });
}
const SHA = 'c'.repeat(40);
const plugin: HostPlugin = {
  name: 'acme',
  marketplace: { source: 'acme/plugins', ref: SHA },
};
const marketplace = {
  source: 'github',
  repo: 'Acme/Plugins',
  ref: SHA,
  installationPreference: 'required',
  expectedName: 'acme-marketplace',
};

describe('caller-owned Linux Cowork desktop', () => {
  it('only probes prepared settings and never changes or tears down the runtime', async () => {
    const lifecycle = await prepare();
    await lifecycle.dispose();
    expect(
      JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    ).toEqual(settings);
    expect(child.exec).toHaveBeenCalledOnce();
    expect(child.exec.mock.calls[0]![1]).toContain('probe');
  });
  it('accepts a pinned required plugin marketplace with its own MCP server blocked', async () => {
    const prepared = {
      ...settings,
      allowedPluginMarketplaces: [marketplace],
      managedMcpServers: [
        ...settings.managedMcpServers,
        {
          name: 'acme_mcp',
          transport: 'policy-only',
          toolPolicy: { '*': 'blocked' },
        },
      ],
    };
    await (await prepare(prepared, [plugin])).dispose();
    expect(child.exec).toHaveBeenCalledOnce();
    expect(coworkPluginSettingsMatch(prepared, [plugin])).toBe(true);
  });
  it.each([
    ['missing', settings, [plugin]],
    [
      'unpinned',
      {
        ...settings,
        allowedPluginMarketplaces: [{ ...marketplace, ref: 'main' }],
      },
      [plugin],
    ],
    [
      'not required',
      {
        ...settings,
        allowedPluginMarketplaces: [
          { ...marketplace, installationPreference: 'available' },
        ],
      },
      [plugin],
    ],
    [
      'unexpected',
      { ...settings, allowedPluginMarketplaces: [marketplace] },
      undefined,
    ],
  ])(
    'fails before UI when the plugin marketplace is %s',
    async (_kind, value, plugins) => {
      await expect(prepare(value, plugins)).rejects.toThrow(
        'Prepared Linux desktop settings do not match'
      );
      expect(child.exec).not.toHaveBeenCalled();
    }
  );
  it.each([
    { ...settings, inferenceModels: [{ name: 'wrong-model' }] },
    { ...settings, managedMcpServers: [] },
    {
      ...settings,
      managedMcpServers: [
        { name: 'glean', transport: 'http', url: 'https://wrong.example/eval' },
      ],
    },
    {
      ...settings,
      managedMcpServers: [
        { ...settings.managedMcpServers[0], toolPolicy: { '*': 'allow' } },
      ],
    },
    {
      ...settings,
      managedMcpServers: [
        { name: 'glean', transport: 'stdio', command: '/usr/bin/node' },
      ],
    },
    {
      ...settings,
      managedMcpServers: [
        ...settings.managedMcpServers,
        {
          name: 'glean_plugin',
          transport: 'policy-only',
          toolPolicy: { '*': 'allow' },
        },
      ],
    },
  ])(
    'fails before UI when prepared settings do not match the manifest',
    async (value) => {
      await expect(prepare(value)).rejects.toThrow('settings do not match');
      expect(child.exec).not.toHaveBeenCalled();
    }
  );
  it('rejects symlinked or oversized prepared settings before touching the desktop', async () => {
    const file = join(directory, 'actual.json');
    const link = join(directory, 'linked.json');
    await writeFile(file, JSON.stringify(settings));
    await symlink(file, link);
    await expect(
      linuxCoworkPlatform.prepare({
        manifest,
        env: { ...session, MST_COWORK_SETTINGS_FILE: link },
      })
    ).rejects.toThrow('settings do not match');
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(
      linuxCoworkPlatform.prepare({
        manifest,
        env: { ...session, MST_COWORK_SETTINGS_FILE: file },
      })
    ).rejects.toThrow('settings do not match');
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('does not perform caller-owned recovery', async () => {
    await expect(linuxCoworkPlatform.recover()).rejects.toThrow(
      'runtime owner'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('bounds UI submission independently of the native execution deadline', async () => {
    await linuxCoworkPlatform.submit('unchanged', {
      deadlineAt: Date.now() + 900_000,
      env: session,
    });
    const [, args, execution] = child.exec.mock.calls[0]!;
    expect(execution.timeout).toBe(60_000);
    expect(args[args.indexOf('--timeout-ms') + 1]).toBe('59000');
  });
  it('reports bounded driver error codes without including arbitrary diagnostics', async () => {
    child.responses.push({
      failed: true,
      value: {
        status: 'failed',
        action_count: 1,
        duration_ms: 5,
        error: 'deadline_exceeded',
      },
    });
    await expect(
      linuxCoworkPlatform.submit('unchanged', options())
    ).rejects.toThrow('deadline_exceeded');
    child.responses.push({
      failed: true,
      value: {
        status: 'failed',
        action_count: 1,
        duration_ms: 5,
        error: 'secret child diagnostic',
      },
    });
    await expect(
      linuxCoworkPlatform.submit('unchanged', options())
    ).rejects.not.toThrow('secret child diagnostic');
  });
  it('passes the exact prompt over stdin and reports no imaginary planner usage', async () => {
    const prompt = '  Unicode 中文\nsecond line  ';
    const result = await linuxCoworkPlatform.submit(prompt, options());
    expect(child.payloads).toEqual([JSON.stringify({ prompt })]);
    expect(child.exec.mock.calls[0]![1]).not.toContain(prompt);
    expect(child.exec.mock.calls[0]![2].env).toMatchObject({
      MST_COWORK_URL_OPENER: '/prepared/open-url',
    });
    expect(child.exec.mock.calls[0]![2].env).not.toHaveProperty(
      'ANTHROPIC_API_KEY'
    );
    expect(result).toMatchObject({
      status: 'submitted',
      telemetry: {
        driver: 'linux-desktop',
        planner: { status: 'not-applicable' },
        cost: { status: 'not-applicable' },
      },
    });
    expect(result.telemetry).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('model');
  });
  it('does not retry an uncertain submission or expose raw errors', async () => {
    child.responses.push({
      failed: true,
      value: {
        status: 'failed',
        action_count: 1,
        duration_ms: 2,
        secret: 'do-not-forward-secret',
      },
    });
    await expect(
      linuxCoworkPlatform.submit('query', options())
    ).rejects.toThrow('no retry');
    expect(child.exec).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 'submitted', action_count: -1, duration_ms: 1 },
    { status: 'submitted', action_count: 1, duration_ms: 'bad' },
  ])('rejects malformed receipts', async (value) => {
    child.responses.push({ value });
    await expect(
      linuxCoworkPlatform.submit('query', options())
    ).rejects.toBeInstanceOf(CoworkDriverError);
    expect(child.exec).toHaveBeenCalledOnce();
  });
  it.each(['', 'relative-opener', 'program --flag'])(
    'rejects an invalid configured URL opener before launching: %j',
    async (opener) => {
      await expect(
        linuxCoworkPlatform.submit('query', {
          ...options(),
          env: { ...session, MST_COWORK_URL_OPENER: opener },
        })
      ).rejects.toThrow('absolute executable path');
      expect(child.exec).not.toHaveBeenCalled();
    }
  );
  it('does not launch a process after its deadline', async () => {
    await expect(
      linuxCoworkPlatform.submit('query', { ...options(), deadlineAt: 0 })
    ).rejects.toThrow('deadline');
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('skips approvals once the bound native session completes', async () => {
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => true,
    });
    expect(result.action_count).toBe(0);
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('checks only approvals until native completion and respects the action budget', async () => {
    const isComplete = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete,
      approveWriteTools: true,
    });
    expect(result.action_count).toBe(1);
    expect(child.payloads).toEqual([
      JSON.stringify({ approveWriteTools: true }),
    ]);
    expect(child.exec.mock.calls[0]![1]).toContain('hitl');
    await expect(
      linuxCoworkPlatform.handleHitl({
        ...options(),
        maxActions: 1,
        isComplete: async () => false,
      })
    ).rejects.toBeInstanceOf(CoworkHitlBudgetError);
  });
  it('refuses unbound HITL', async () => {
    await expect(linuxCoworkPlatform.handleHitl(options())).rejects.toThrow(
      'bound native'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
});
