import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  coworkHeadlessSettings,
  coworkHeadlessSettingsMatch,
  coworkManagedPluginSettings,
  coworkPluginSettingsMatch,
  linuxCoworkPlatform,
  COWORK_MANAGED_ONLY,
  desktopRestartTimeoutMs,
  installedDebVersion,
} from './linux.js';
import type { MarketplacePlugin } from '../clientPlugins.js';
import {
  CoworkDriverError,
  CoworkHitlBudgetError,
  CoworkHitlError,
  CoworkUserQuestionError,
} from './driver.js';
import type * as ChildProcess from 'node:child_process';
import type { EvalConfig } from '../evalConfig.js';
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
const evalConfig: EvalConfig = {
  name: 'linux-contract',
  datasets: [],
  client: 'cowork',
  clientOptions: { computerUseProvider: 'linux-desktop' },
  servers: [
    {
      transport: 'http',
      label: 'primary',
      serverUrl: 'https://example.com/eval',
    },
  ],
};
const settings = {
  inferenceModels: [{ name: 'test-model' }],
  managedMcpServers: [
    { name: 'primary', transport: 'http', url: 'https://example.com/eval' },
  ],
  ...COWORK_MANAGED_ONLY,
  disabledBuiltinTools: ['AskUserQuestion'],
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

async function prepare(
  value: unknown = settings,
  plugins?: MarketplacePlugin[]
) {
  const file = join(directory, 'settings.json');
  await writeFile(file, JSON.stringify(value));
  return linuxCoworkPlatform.prepare({
    evalConfig,
    model: 'test-model',
    env: { ...session, MST_COWORK_SETTINGS_FILE: file },
    ...(plugins ? { plugins } : {}),
  });
}
const SHA = 'c'.repeat(40);
const plugin: MarketplacePlugin = {
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

describe('a failed Linux Cowork case (diagnose)', () => {
  it("keeps the driver's read-only capture, the end of Cowork's logs, and the machine's state", async () => {
    const claude = join(directory, 'Claude-3p');
    const dataDir = join(claude, 'local-agent-mode-sessions');
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(claude, 'logs'));
    await writeFile(
      join(claude, 'logs', 'main.log'),
      `${'x'.repeat(300 * 1024)}END\n`
    );
    await writeFile(join(claude, 'logs', 'cowork_vm_node.log'), 'vm ok\n');
    await writeFile(join(claude, 'logs', 'notes.txt'), 'not a log');
    const out = join(directory, 'diagnosis');
    await mkdir(out);
    child.responses.push({
      value: { status: 'diagnosed', action_count: 0, duration_ms: 5 },
    });
    await linuxCoworkPlatform.diagnose!({ dir: out, dataDir, env: session });

    // The driver ran in diagnose mode, told only where to write.
    const args = child.exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--mode') + 1]).toBe('diagnose');
    expect(JSON.parse(child.payloads[0]!)).toEqual({ dir: out });
    // The end of each log, at most 256 KiB; nothing that isn't a log.
    const main = await readFile(join(out, 'logs', 'main.log'), 'utf8');
    expect(main.length).toBe(256 * 1024);
    expect(main.endsWith('END\n')).toBe(true);
    expect(
      await readFile(join(out, 'logs', 'cowork_vm_node.log'), 'utf8')
    ).toBe('vm ok\n');
    await expect(stat(join(out, 'logs', 'notes.txt'))).rejects.toThrow();
    const system = JSON.parse(await readFile(join(out, 'system.json'), 'utf8'));
    expect(system.memory.totalBytes).toBeGreaterThan(0);
    expect(system.dataDisk.freeBytes).toBeGreaterThan(0);
  });

  it("still keeps the logs and the machine's state when the driver can't capture", async () => {
    const dataDir = join(directory, 'Claude-3p', 'local-agent-mode-sessions');
    await mkdir(dataDir, { recursive: true });
    const out = join(directory, 'diagnosis');
    await mkdir(out);
    child.responses.push({ failed: true });
    await linuxCoworkPlatform.diagnose!({ dir: out, dataDir, env: session });
    expect(
      JSON.parse(await readFile(join(out, 'system.json'), 'utf8'))
    ).toHaveProperty('memory');
  });
});

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
    ['missing', (({ disabledBuiltinTools: _omit, ...rest }) => rest)(settings)],
    ['empty', { ...settings, disabledBuiltinTools: [] }],
    [
      'without AskUserQuestion',
      { ...settings, disabledBuiltinTools: ['Bash'] },
    ],
    ['not a list', { ...settings, disabledBuiltinTools: 'AskUserQuestion' }],
  ])(
    'fails before UI when headless built-in tools are %s',
    async (_kind, value) => {
      await expect(prepare(value)).rejects.toThrow(
        'Prepared Linux desktop settings do not match'
      );
      expect(child.exec).not.toHaveBeenCalled();
    }
  );
  it('builds the exact headless settings it requires', () => {
    expect(coworkHeadlessSettings()).toEqual({
      disabledBuiltinTools: ['AskUserQuestion'],
    });
    expect(coworkHeadlessSettingsMatch(coworkHeadlessSettings())).toBe(true);
    // A caller mutating its copy cannot weaken the contract.
    coworkHeadlessSettings().disabledBuiltinTools.length = 0;
    expect(coworkHeadlessSettings().disabledBuiltinTools).toEqual([
      'AskUserQuestion',
    ]);
    expect(
      coworkHeadlessSettingsMatch({
        disabledBuiltinTools: ['AskUserQuestion', 1],
      })
    ).toBe(false);
  });
  it('accepts settings that disable more built-in tools than required', async () => {
    await (
      await prepare({
        ...settings,
        disabledBuiltinTools: ['WebFetch', 'AskUserQuestion'],
      })
    ).dispose();
  });
  it.each([
    { ...settings, inferenceModels: [{ name: 'wrong-model' }] },
    { ...settings, managedMcpServers: [] },
    {
      ...settings,
      managedMcpServers: [
        {
          name: 'primary',
          transport: 'http',
          url: 'https://wrong.example/eval',
        },
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
        { name: 'primary', transport: 'stdio', command: '/usr/bin/node' },
      ],
    },
    {
      ...settings,
      managedMcpServers: [
        ...settings.managedMcpServers,
        {
          name: 'acme_plugin',
          transport: 'policy-only',
          toolPolicy: { '*': 'allow' },
        },
      ],
    },
  ])(
    'fails before UI when prepared settings do not match the eval config',
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
        evalConfig,
        env: { ...session, MST_COWORK_SETTINGS_FILE: link },
      })
    ).rejects.toThrow('settings do not match');
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(
      linuxCoworkPlatform.prepare({
        evalConfig,
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
  it('allows a UI submission up to ten minutes within the case deadline', async () => {
    await linuxCoworkPlatform.submit('unchanged', {
      deadlineAt: Date.now() + 900_000,
      env: session,
    });
    const [, args, execution] = child.exec.mock.calls[0]!;
    expect(execution.timeout).toBe(10 * 60_000);
    expect(args[args.indexOf('--timeout-ms') + 1]).toBe('599000');
  });
  it('never lets a UI submission outlast a shorter case deadline', async () => {
    await linuxCoworkPlatform.submit('unchanged', {
      deadlineAt: Date.now() + 30_000,
      env: session,
    });
    const [, args, execution] = child.exec.mock.calls[0]!;
    expect(execution.timeout).toBeGreaterThan(0);
    expect(execution.timeout).toBeLessThanOrEqual(30_000);
    expect(Number(args[args.indexOf('--timeout-ms') + 1])).toBeLessThan(
      Number(execution.timeout)
    );
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
  it("lets reset stop the failed case's task, then open the empty task", async () => {
    child.responses.push({
      value: {
        status: 'ready',
        action_count: 2,
        duration_ms: 1,
        stopped: true,
      },
    });
    await linuxCoworkPlatform.reset!(options());
    const args = child.exec.mock.calls[0]![1] as string[];
    expect(
      args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2)
    ).toEqual(['--mode', 'reset']);
    // Stop response, and the new-task link: two actions, never a send.
    expect(args[args.indexOf('--max-actions') + 1]).toBe('2');
  });
  it('fails fast when the bound task waits on an AskUserQuestion answer', async () => {
    const pending = linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => false,
      awaitingUser: async () => true,
    });
    await expect(pending).rejects.toBeInstanceOf(CoworkUserQuestionError);
    await expect(pending).rejects.toMatchObject({ kind: 'awaiting-user' });
    // No approval click is attempted for a question.
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('says why HITL failed, and that a failed completion check touched nothing', async () => {
    const pending = linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => {
        throw new Error('Bound native session is missing or ambiguous.');
      },
    });
    await expect(pending).rejects.toBeInstanceOf(CoworkHitlError);
    await expect(pending).rejects.toMatchObject({
      message:
        'Linux HITL failed for the bound native session: Bound native session is missing or ambiguous.',
      touchedUi: false,
    });
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('goes on past a scan that could not finish, and counts it', async () => {
    // A presented spreadsheet can make one pass's scan too large to finish:
    // that pass saw no prompt; the next one may.
    child.responses.push({
      failed: false,
      value: {
        status: 'hitl_checked',
        action_count: 0,
        duration_ms: 1,
        scan: 'incomplete',
      },
    });
    let checks = 0;
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => ++checks > 1,
    });
    expect(result).toMatchObject({
      status: 'hitl_checked',
      action_count: 0,
      telemetry: { accounting: 'complete', incomplete_scans: 1 },
    });
  });
  it('counts a folder request it denied, and goes on until the task finishes', async () => {
    child.responses.push({
      value: {
        status: 'hitl_checked',
        action_count: 1,
        duration_ms: 1,
        denied: 'folder_request',
      },
    });
    let checks = 0;
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => ++checks > 1,
    });
    expect(result).toMatchObject({
      action_count: 1,
      telemetry: { accounting: 'complete', folder_requests_denied: 1 },
    });
  });
  it('counts a driver call that failed with a receipt by its actions', async () => {
    child.responses.push({
      failed: true,
      value: {
        status: 'failed',
        action_count: 0,
        duration_ms: 1,
        error: 'approval_control_ambiguous',
      },
    });
    const pending = linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => false,
    });
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('(approval_control_ambiguous)'),
      touchedUi: false,
    });
  });
  it('treats a driver call that failed without a receipt as one that may have acted', async () => {
    child.responses.push({ failed: true, value: 'not a receipt' });
    await expect(
      linuxCoworkPlatform.handleHitl({
        ...options(),
        isComplete: async () => false,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('(missing_or_invalid_receipt)'),
      touchedUi: true,
    });
  });
  it('refuses unbound HITL', async () => {
    await expect(linuxCoworkPlatform.handleHitl(options())).rejects.toThrow(
      'bound native'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
});

describe('owned Linux Cowork desktop (MST_DESKTOP_OWNED=1)', () => {
  const RESTART = '/opt/mst/restart-desktop';
  // The image's own settings: another model, a header helper, a stale server.
  const image = {
    inferenceProvider: 'gateway',
    inferenceModels: [
      { name: 'other-model' },
      { name: 'test-model', provider: 'gateway' },
    ],
    managedMcpServers: [
      {
        name: 'primary',
        transport: 'http',
        url: 'https://example.com/eval',
        headersHelper: '/opt/mst/primary-headers.sh',
      },
      { name: 'stale', transport: 'http', url: 'https://example.com/old' },
    ],
    // Keys an older MST wrote, which Claude Desktop rejects: dropped.
    allowedMcpServers: [{ serverName: 'stale' }],
    allowManagedMcpServersOnly: true,
  };

  async function prepareOwned(
    env: Record<string, string> = {},
    base: Record<string, unknown> = image
  ) {
    const file = join(directory, 'settings.json');
    const original = `${JSON.stringify(base, null, 2)}\n`;
    await writeFile(file, original);
    const lifecycle = linuxCoworkPlatform.prepare({
      evalConfig,
      model: 'test-model',
      env: {
        ...session,
        MST_COWORK_SETTINGS_FILE: file,
        MST_DESKTOP_OWNED: '1',
        MST_DESKTOP_RESTART: RESTART,
        ...env,
      },
    });
    return { file, original, lifecycle };
  }

  it("writes the variant's settings, restarts the desktop, and restores the file", async () => {
    const { file, original, lifecycle } = await prepareOwned();
    const prepared = await lifecycle;

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      inferenceProvider: 'gateway',
      inferenceModels: [{ name: 'test-model', provider: 'gateway' }],
      managedMcpServers: [
        {
          name: 'primary',
          transport: 'http',
          url: 'https://example.com/eval',
          headersHelper: '/opt/mst/primary-headers.sh',
        },
      ],
      isLocalDevMcpEnabled: false,
      isDesktopExtensionEnabled: false,
      disabledBuiltinTools: ['AskUserQuestion'],
    });
    // The restart, then the usual probe.
    expect(child.exec.mock.calls.map((call) => String(call[0]))).toEqual([
      RESTART,
      'python3',
    ]);
    expect(child.exec.mock.calls[1]![1]).toContain('probe');

    await prepared.dispose();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it("keeps the image's own disabled built-in tools beside AskUserQuestion", async () => {
    const { file, lifecycle } = await prepareOwned(
      {},
      { ...image, disabledBuiltinTools: ['WebFetch', 'AskUserQuestion'] }
    );
    const prepared = await lifecycle;
    expect(
      JSON.parse(await readFile(file, 'utf8')).disabledBuiltinTools
    ).toEqual(['WebFetch', 'AskUserQuestion']);
    await prepared.dispose();
  });

  it('needs a restart command, and touches nothing without one', async () => {
    const { file, original, lifecycle } = await prepareOwned({
      MST_DESKTOP_RESTART: '',
    });
    await expect(lifecycle).rejects.toThrow('needs MST_DESKTOP_RESTART');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(child.exec).not.toHaveBeenCalled();
  });

  it("gives a server with credentials MST's headers helper, never the secret in the settings", async () => {
    const file = join(directory, 'settings.json');
    await writeFile(file, `${JSON.stringify(image, null, 2)}\n`);
    const token = 'connector-token-123';
    const prepared = await linuxCoworkPlatform.prepare({
      evalConfig: {
        ...evalConfig,
        servers: [
          ...evalConfig.servers!,
          {
            transport: 'http',
            label: 'docs',
            serverUrl: 'https://docs.example/mcp',
            auth: { accessTokenEnv: 'MST_CONNECTOR_TOKEN_DOCS' },
          },
        ],
      },
      model: 'test-model',
      env: {
        ...session,
        MST_COWORK_SETTINGS_FILE: file,
        MST_DESKTOP_OWNED: '1',
        MST_DESKTOP_RESTART: RESTART,
        MST_CONNECTOR_TOKEN_DOCS: token,
        // Where the helper can run: the headers stay beside the settings.
        MST_COWORK_HELPER_DIR: join(directory, 'helpers'),
      },
    });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(token);
    const helper = join(directory, 'helpers', 'docs-headers');
    const servers = JSON.parse(text).managedMcpServers;
    expect(servers).toEqual([
      // The image's helper, for a server with no credentials of MST's.
      expect.objectContaining({
        name: 'primary',
        headersHelper: '/opt/mst/primary-headers.sh',
      }),
      {
        name: 'docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        headersHelper: helper,
      },
    ]);
    const headers = join(directory, 'mcp-headers', 'docs.json');
    expect((await stat(headers)).mode & 0o777).toBe(0o600);
    expect((await stat(helper)).mode & 0o777).toBe(0o700);
    // What Claude Desktop runs when it connects.
    const { spawnSync } =
      await vi.importActual<typeof ChildProcess>('node:child_process');
    const run = spawnSync(helper, { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      Authorization: `Bearer ${token}`,
    });

    await prepared.dispose();
    await expect(stat(headers)).rejects.toThrow();
    await expect(stat(helper)).rejects.toThrow();
  });

  it('restarts the desktop again when a restart fails, before failing the variant', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      child.responses.push({ failed: true });
      const prepared = await (await prepareOwned()).lifecycle;
      expect(child.exec.mock.calls.map((call) => String(call[0]))).toEqual([
        RESTART,
        RESTART,
        'python3',
      ]);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
        'desktop restart failed'
      );
      await prepared.dispose();
    } finally {
      stderr.mockRestore();
    }
  });

  it('fails the variant and restores the settings when both restarts fail', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      child.responses.push({ failed: true }, { failed: true });
      const { file, original, lifecycle } = await prepareOwned();
      await expect(lifecycle).rejects.toThrow(
        /failed after MST wrote the variant settings, 2 times/
      );
      expect(child.exec.mock.calls.map((call) => String(call[0]))).toEqual([
        RESTART,
        RESTART,
      ]);
      expect(await readFile(file, 'utf8')).toBe(original);
    } finally {
      stderr.mockRestore();
    }
  });

  it('restores the settings when the desktop is not ready after them', async () => {
    child.responses.push({}, { failed: true });
    const { file, original, lifecycle } = await prepareOwned();
    await expect(lifecycle).rejects.toThrow('Linux desktop probe failed');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('restarts the desktop only when the settings change, or after it was not ready', async () => {
    const restarts = () =>
      child.exec.mock.calls.filter((call) => call[0] === RESTART).length;
    // Another dataset of the same variant: the desktop already runs with it.
    await (await prepareOwned()).lifecycle.then((p) => p.dispose());
    await (await prepareOwned()).lifecycle.then((p) => p.dispose());
    expect(restarts()).toBe(1);
    // Another variant's model.
    const file = join(directory, 'settings.json');
    const other = linuxCoworkPlatform.prepare({
      evalConfig,
      model: 'other-model',
      env: {
        ...session,
        MST_COWORK_SETTINGS_FILE: file,
        MST_DESKTOP_OWNED: '1',
        MST_DESKTOP_RESTART: RESTART,
      },
    });
    await (await other).dispose();
    expect(restarts()).toBe(2);
    // Back to the first: a restart. Then a probe that fails: the next
    // prepare restarts even with the same settings.
    child.responses.push({}, { failed: true });
    await expect((await prepareOwned()).lifecycle).rejects.toThrow(
      'Linux desktop probe failed'
    );
    expect(restarts()).toBe(3);
    await (await prepareOwned()).lifecycle.then((p) => p.dispose());
    expect(restarts()).toBe(4);
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
  const fake: MarketplacePlugin = {
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
    ...COWORK_MANAGED_ONLY,
    ...coworkHeadlessSettings(),
  });
  async function prepareStdio(
    value: unknown,
    env: Record<string, string> = { FAKE_TOKEN: 'tok' }
  ) {
    const file = join(directory, 'settings.json');
    await writeFile(file, JSON.stringify(value));
    return linuxCoworkPlatform.prepare({
      evalConfig: { ...evalConfig, servers: [evalServer] },
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
      "the user's own MCP servers are on",
      mutate((v) => {
        (v as Record<string, unknown>).isLocalDevMcpEnabled = true;
      }),
    ],
    [
      'desktop extensions are on',
      mutate((v) => {
        delete (v as Record<string, unknown>).isDesktopExtensionEnabled;
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

describe('installedDebVersion', () => {
  const status = [
    'Package: claude-desktop-beta',
    'Status: install ok installed',
    'Version: 9.9.9',
    '',
    'Package: claude-desktop',
    'Status: install ok installed',
    'Architecture: arm64',
    'Version: 2.31226.1',
    'Depends: libgtk-3-0',
    '',
    'Package: removed-app',
    'Status: deinstall ok config-files',
    'Version: 1.0',
    '',
  ].join('\n');

  it("reads an installed package's version from dpkg's status file", () => {
    expect(installedDebVersion(status, 'claude-desktop')).toBe('2.31226.1');
    // Removed, with only its config files left: not installed.
    expect(installedDebVersion(status, 'removed-app')).toBeUndefined();
    expect(installedDebVersion(status, 'missing')).toBeUndefined();
  });
});

describe('desktopRestartTimeoutMs', () => {
  it('gives the restart command 5 minutes, or what the image sets', () => {
    expect(desktopRestartTimeoutMs({})).toBe(300_000);
    expect(
      desktopRestartTimeoutMs({ MST_DESKTOP_RESTART_TIMEOUT_S: '900' })
    ).toBe(900_000);
    for (const value of ['0', '3601', '1.5', 'soon'])
      expect(() =>
        desktopRestartTimeoutMs({ MST_DESKTOP_RESTART_TIMEOUT_S: value })
      ).toThrow('MST_DESKTOP_RESTART_TIMEOUT_S');
  });
});
