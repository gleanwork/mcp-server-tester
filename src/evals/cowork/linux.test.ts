import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  coworkManagedPluginSettings,
  coworkPluginSettingsMatch,
  linuxCoworkPlatform,
} from './linux.js';
import type { HostPlugin } from '../hostPlugins.js';
import { CoworkDriverError, CoworkHitlBudgetError } from './driver.js';
import type { EvalManifest } from '../evalManifest.js';
import type { MCPConfig } from '../../config/mcpConfig.js';

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

describe('Linux Cowork plugins with a stdio eval server', () => {
  const evalServer = {
    transport: 'stdio',
    label: 'fake-eval',
    command: '/usr/bin/node',
    args: ['${pluginRoot:fake}/mcp/start.mjs'],
    url: 'https://example.test/mcp/default/eval',
    auth: { accessTokenEnv: 'FAKE_TOKEN' },
    minTools: 4,
    env: {
      FAKE_MCP_URL: '${url}',
      FAKE_PLUGIN_DATA: '${dataDir}',
      ENABLE_HITL: 'false',
    },
    files: {
      'creds.json': {
        tokens: { access_token: '${bearerToken}', token_type: 'Bearer' },
      },
    },
  } as MCPConfig;
  const fake: HostPlugin = {
    name: 'fake',
    marketplace: { source: 'acme/plugins', ref: SHA },
    blockMcpServers: ['fake_plugin'],
  };
  let root: string;
  let dataRoot: string;
  let stdioPaths: { pluginRoots: Record<string, string>; dataRoot: string };
  const credentials = {
    tokens: { access_token: 'tok', token_type: 'Bearer' },
  };
  beforeEach(async () => {
    // Paths are compared after realpath; macOS tmpdir is under a /var symlink.
    const base = await realpath(directory);
    root = join(base, 'plugins', 'fake');
    dataRoot = join(base, 'mcp-data');
    await mkdir(join(root, 'mcp'), { recursive: true });
    await mkdir(join(dataRoot, 'fake-eval'), { recursive: true, mode: 0o700 });
    await chmod(dataRoot, 0o700);
    await writeFile(
      join(dataRoot, 'fake-eval', 'creds.json'),
      JSON.stringify(credentials),
      { mode: 0o600 }
    );
    stdioPaths = { pluginRoots: { fake: root }, dataRoot };
  });
  const expected = () =>
    coworkManagedPluginSettings({
      servers: [evalServer],
      plugins: [fake],
      paths: stdioPaths,
    });
  const valid = () => ({
    inferenceModels: [{ name: 'test-model' }],
    ...expected(),
    allowManagedMcpServersOnly: true,
  });
  async function prepareStdio(
    value: unknown,
    env: Record<string, string> = { FAKE_TOKEN: 'tok' }
  ) {
    const file = join(directory, 'settings.json');
    await writeFile(file, JSON.stringify(value));
    return linuxCoworkPlatform.prepare({
      manifest: { ...manifest, servers: [evalServer] },
      model: 'test-model',
      env: { ...session, ...env, MST_COWORK_SETTINGS_FILE: file },
      plugins: [fake],
      stdioPaths,
    });
  }

  it('builds the managed entries: stdio server, blocked plugin server, pinned marketplace', () => {
    expect(expected()).toEqual({
      managedMcpServers: [
        {
          name: 'fake-eval',
          transport: 'stdio',
          command: '/usr/bin/node',
          args: [join(root, 'mcp/start.mjs')],
          env: {
            FAKE_MCP_URL: 'https://example.test/mcp/default/eval',
            FAKE_PLUGIN_DATA: join(dataRoot, 'fake-eval'),
            ENABLE_HITL: 'false',
          },
        },
        {
          name: 'fake_plugin',
          transport: 'policy-only',
          toolPolicy: { '*': 'blocked' },
        },
      ],
      allowedMcpServers: [{ serverName: 'fake-eval' }],
      allowedPluginMarketplaces: [
        {
          source: 'github',
          repo: 'acme/plugins',
          ref: SHA,
          installationPreference: 'required',
        },
      ],
    });
    expect(JSON.stringify(expected())).not.toContain('tok"');
  });

  it('accepts matching settings, paths, and private files', async () => {
    await (await prepareStdio(valid())).dispose();
    expect(child.exec).toHaveBeenCalledOnce();
  });

  const mutate =
    (change: (settings: ReturnType<typeof valid>) => void) => () => {
      const value = valid();
      change(value);
      return value;
    };
  const stdioEntry = (value: ReturnType<typeof valid>) =>
    value.managedMcpServers[0] as unknown as Record<string, unknown>;
  it.each([
    [
      'the env URL differs from url',
      mutate((v) => {
        (stdioEntry(v).env as Record<string, string>).FAKE_MCP_URL =
          'https://example.test/mcp/default';
      }),
    ],
    [
      'args are unresolved',
      mutate((v) => {
        stdioEntry(v).args = ['${pluginRoot:fake}/mcp/start.mjs'];
      }),
    ],
    [
      'the plugin HITL env is not overridden',
      mutate((v) => {
        (stdioEntry(v).env as Record<string, string>).ENABLE_HITL = 'true';
      }),
    ],
    [
      'an extra env var is present',
      mutate((v) => {
        (stdioEntry(v).env as Record<string, string>).FAKE_TOKEN = 'tok';
      }),
    ],
    [
      'the command differs',
      mutate((v) => {
        stdioEntry(v).command = 'node';
      }),
    ],
    [
      'the entry has an extra key',
      mutate((v) => {
        stdioEntry(v).cwd = '/tmp';
      }),
    ],
    [
      'the stdio server is not allowed',
      mutate((v) => {
        v.allowedMcpServers = [];
      }),
    ],
    [
      'write tools are pre-approved',
      mutate((v) => {
        stdioEntry(v).toolPolicy = { '*': 'allow' };
      }),
    ],
    [
      'the plugin server is not blocked',
      mutate((v) => {
        v.managedMcpServers.pop();
      }),
    ],
    [
      'the plugin server is only partly blocked',
      mutate((v) => {
        v.managedMcpServers[1] = {
          name: 'fake_plugin',
          transport: 'policy-only',
          toolPolicy: { '*': 'blocked', search: 'allow' },
        } as never;
      }),
    ],
    [
      'the stdio server is missing',
      mutate((v) => {
        v.managedMcpServers.shift();
      }),
    ],
    [
      'managed-only is off',
      mutate((v) => {
        (v as Record<string, unknown>).allowManagedMcpServersOnly = false;
      }),
    ],
    [
      'the marketplace is missing',
      mutate((v) => {
        delete (v as Record<string, unknown>).allowedPluginMarketplaces;
      }),
    ],
  ])('fails closed before UI when %s', async (_kind, value) => {
    await expect(prepareStdio(value())).rejects.toThrow(
      'settings do not match'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the credential file has other contents',
      async () =>
        writeFile(
          join(dataRoot, 'fake-eval', 'creds.json'),
          JSON.stringify({ tokens: { access_token: 'other' } })
        ),
    ],
    [
      'the credential file is group-readable',
      async () => chmod(join(dataRoot, 'fake-eval', 'creds.json'), 0o640),
    ],
    [
      'the data dir is not private',
      async () => chmod(join(dataRoot, 'fake-eval'), 0o755),
    ],
    [
      'the credential file is a symlink',
      async () => {
        const file = join(dataRoot, 'fake-eval', 'creds.json');
        await writeFile(
          join(directory, 'real.json'),
          JSON.stringify(credentials)
        );
        await rm(file);
        await symlink(join(directory, 'real.json'), file);
      },
    ],
    [
      'the credential file is missing',
      async () => rm(join(dataRoot, 'fake-eval', 'creds.json')),
    ],
    ['the plugin root is missing', async () => rm(root, { recursive: true })],
    [
      'the plugin root is a symlink',
      async () => {
        await rm(root, { recursive: true });
        await mkdir(join(directory, 'elsewhere'));
        await symlink(join(directory, 'elsewhere'), root);
      },
    ],
  ])('fails closed before UI when %s', async (_kind, change) => {
    await change();
    await expect(prepareStdio(valid())).rejects.toThrow(
      'settings do not match'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });

  it('fails closed when the eval credential is not in the environment', async () => {
    await expect(prepareStdio(valid(), {})).rejects.toThrow(
      'settings do not match'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
});
