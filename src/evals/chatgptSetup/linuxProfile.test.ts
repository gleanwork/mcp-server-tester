import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginWithApiKey } from '../codexSetup/auth.js';
import { probeAppServerStatus } from '../codexSetup/appServerStatus.js';
import type * as AppServerModule from '../codexSetup/appServerStatus.js';
import type * as PluginsModule from '../codexSetup/plugins.js';
import type { AppServerAuthStatus } from '../codexSetup/appServerStatus.js';
import { CodexSetupError } from '../codexSetup/native.js';
import { checkMcpServers } from '../mcpReadiness.js';
import { installCodexPlugins } from '../codexSetup/plugins.js';
import { linuxEnvironment } from '../chatgpt/linuxEnvironment.fixture.js';
import {
  createLinuxChatgptProfile,
  readLinuxChatgptEnvironment,
} from './linuxProfile.js';
import type { ResolvedCodexSetup } from '../codexSetup/config.js';

vi.mock('../codexSetup/auth.js', () => ({ loginWithApiKey: vi.fn() }));
vi.mock('../codexSetup/appServerStatus.js', async (original) => ({
  ...(await original<typeof AppServerModule>()),
  probeAppServerStatus: vi.fn(),
}));
vi.mock('../mcpReadiness.js', () => ({ checkMcpServers: vi.fn() }));
vi.mock('../codexSetup/plugins.js', async (original) => ({
  ...(await original<typeof PluginsModule>()),
  installCodexPlugins: vi.fn(),
}));

const TOKEN = 'tok-sentinel';
const POLICY = { approvalPolicy: 'never', sandboxMode: 'danger-full-access' };
let home: string;
let env: Record<string, string>;
const setup: ResolvedCodexSetup = {
  configPath: '',
  configName: 'default',
  content: '',
  servers: [
    {
      transport: 'http',
      label: 'glean',
      url: 'https://example.test/mcp',
      bearerTokenEnvVar: 'MST_CHATGPT_MCP_TOKEN_0',
    },
  ],
};

function preflight(status: 'connected' | 'failed', toolCount = 3) {
  vi.mocked(checkMcpServers).mockResolvedValue([
    { label: 'glean', status, toolCount, elapsedMs: 1 },
  ]);
}
function appServer(
  initialized: boolean,
  authStatus: AppServerAuthStatus = 'bearerToken'
) {
  vi.mocked(probeAppServerStatus).mockResolvedValue({
    status: 'available',
    servers: [
      {
        label: 'glean',
        initialized,
        toolCount: initialized ? 3 : null,
        authStatus,
      },
    ],
  });
}
async function createProfile(platform: NodeJS.Platform = 'linux') {
  return createLinuxChatgptProfile(readLinuxChatgptEnvironment(env), platform);
}

beforeEach(async () => {
  vi.resetAllMocks();
  home = await realpath(await mkdtemp(join(tmpdir(), 'mst-linux-profile-')));
  env = linuxEnvironment(home);
  for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'MST_CHATGPT_EVIDENCE_DIR'])
    await mkdir(env[key]!, { mode: 0o700 });
  await mkdir(join(home, 'bin'));
  for (const key of ['MST_CHATGPT_APP_PATH', 'MST_CHATGPT_CODEX_PATH']) {
    env[key] = join(home, 'bin', key);
    await writeFile(env[key], '#!/bin/sh\n', { mode: 0o700 });
  }
  vi.mocked(loginWithApiKey).mockResolvedValue({
    loginVerified: true,
    method: 'api-key',
  });
  preflight('connected');
  appServer(true);
});
afterEach(async () => {
  await chmod(home, 0o700);
  await rm(home, { recursive: true, force: true });
});

describe('Linux ChatGPT environment contract', () => {
  it('accepts the Scio contract and forwards only session variables', () => {
    const parsed = readLinuxChatgptEnvironment({
      ...env,
      OPENAI_API_KEY: 'secret-sentinel',
      MST_CHATGPT_MCP_TOKEN_0: 'secret-sentinel',
    });
    expect(parsed).toMatchObject({
      home,
      codexHome: join(home, '.codex'),
      evidenceDir: join(home, 'evidence'),
    });
    // Every fixture session variable plus CODEX_HOME; no MST_* or secrets.
    const sessionKeys = Object.keys(env).filter((k) => !k.startsWith('MST_'));
    expect(Object.keys(parsed.session).sort()).toEqual(
      [...sessionKeys, 'CODEX_HOME'].sort()
    );
    expect(JSON.stringify(parsed.session)).not.toContain('secret-sentinel');
  });

  // An empty value takes the same path as a missing one.
  it.each([
    ['HOME', ''],
    ['HOME', 'relative'],
    ['HOME', '/'],
    ['TMPDIR', '/tmp/../tmp/x'],
    ['XDG_CONFIG_HOME', '/elsewhere/.config'],
    ['DBUS_SESSION_BUS_ADDRESS', 'tcp:host=x'],
    ['AT_SPI_BUS_ADDRESS', ''],
    ['DISPLAY', ''],
    ['GNOME_KEYRING_CONTROL', ''],
    ['MST_CHATGPT_APP_PATH', ''],
    ['MST_CHATGPT_CODEX_PATH', 'codex'],
    ['MST_CHATGPT_API_KEY_FILE', ''],
    ['MST_CHATGPT_EVIDENCE_DIR', ''],
    ['CODEX_HOME', '/home/user/.codex'],
  ])('rejects %s=%j with a fixed code', (key, value) => {
    expect(() => readLinuxChatgptEnvironment({ ...env, [key]: value })).toThrow(
      `environment_invalid: ${key}`
    );
  });
});

describe('fresh MST-owned Linux profile', () => {
  it('creates CODEX_HOME exclusively and one empty private workspace', async () => {
    const profile = await createProfile();
    expect((await stat(join(home, '.codex'))).mode & 0o777).toBe(0o700);
    const workspace = profile.install.trustedProject!;
    expect(workspace).toMatch(join(home, 'tmp', 'mst-chatgpt-workspace-'));
    expect(await readdir(workspace)).toEqual([]);
    expect(profile).toMatchObject({
      configPath: join(home, '.codex', 'config.toml'),
      install: {
        credentialStore: 'keyring',
        executionPolicy: POLICY,
        hostToolPolicy: {
          disabledPlugins: ['unified-computer-use@openai-bundled'],
          webSearch: 'disabled',
        },
      },
      readiness: {
        hostToolPolicy: {
          disabledPlugins: ['unified-computer-use@openai-bundled'],
          webSearch: 'disabled',
        },
      },
      evidenceDir: join(home, 'evidence'),
    });
    await profile.dispose();
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['darwin', 'linux_required', async () => undefined],
    ['existing .codex', 'home_not_fresh', () => mkdir(join(home, '.codex'))],
    ['group-readable HOME', 'home_unsafe', () => chmod(home, 0o750)],
    [
      'non-empty evidence',
      'evidence_dir_unsafe',
      () => writeFile(join(env.MST_CHATGPT_EVIDENCE_DIR!, 'x'), ''),
    ],
    [
      'non-executable app',
      'app_path_invalid',
      () => chmod(env.MST_CHATGPT_APP_PATH!, 0o600),
    ],
  ])('fails closed on %s with %s', async (kind, code, arrange) => {
    await arrange();
    await expect(
      createProfile(kind === 'darwin' ? 'darwin' : 'linux')
    ).rejects.toMatchObject({ code });
  });

  it('logs in without tokens, then preflights and probes MCP with tokens', async () => {
    const profile = await createProfile();
    await profile.beforeStart(setup, { MST_CHATGPT_MCP_TOKEN_0: TOKEN });
    const [codex, loginEnv, keyFile] =
      vi.mocked(loginWithApiKey).mock.calls[0]!;
    expect([codex, keyFile]).toEqual([
      env.MST_CHATGPT_CODEX_PATH,
      env.MST_CHATGPT_API_KEY_FILE,
    ]);
    expect(loginEnv).toMatchObject({
      CODEX_HOME: join(home, '.codex'),
      PATH: '/usr/bin:/bin',
    });
    expect(JSON.stringify(loginEnv)).not.toContain(TOKEN);
    expect(vi.mocked(checkMcpServers).mock.calls[0]![0]).toEqual([
      {
        transport: 'http',
        label: 'glean',
        serverUrl: 'https://example.test/mcp',
        auth: { accessToken: TOKEN },
      },
    ]);
    const [, probeEnv, labels] = vi.mocked(probeAppServerStatus).mock.calls[0]!;
    expect(probeEnv.MST_CHATGPT_MCP_TOKEN_0).toBe(TOKEN);
    expect(labels).toEqual(['glean']);
    expect(profile.readiness).toMatchObject({
      executionPolicy: POLICY,
      login: 'verified',
      mcpPreflight: [{ status: 'connected', toolCount: 3 }],
      mcpStatus: { status: 'available' },
    });
    expect(JSON.stringify(profile.readiness)).not.toContain(TOKEN);
    await profile.dispose();
  });

  it.each([
    ['preflight', 'mcp_preflight_failed', () => preflight('failed')],
    ['zero tools', 'mcp_preflight_failed', () => preflight('connected', 0)],
    [
      'status unavailable',
      'mcp_status_unavailable',
      () =>
        vi
          .mocked(probeAppServerStatus)
          .mockResolvedValue({ status: 'unavailable', reason: 'timeout' }),
    ],
    ['not initialized', 'mcp_server_not_ready', () => appServer(false)],
    [
      'wrong auth',
      'mcp_server_not_ready',
      () => appServer(true, 'notLoggedIn'),
    ],
  ])('fails before app start on %s', async (_kind, code, arrange) => {
    arrange();
    const profile = await createProfile();
    await expect(
      profile.beforeStart(setup, { MST_CHATGPT_MCP_TOKEN_0: TOKEN })
    ).rejects.toMatchObject({ code });
    expect(profile.readiness.error).toBe(code);
    await profile.dispose();
  });

  const plugin = {
    name: 'acme',
    marketplace: { source: '/opt/plugins' },
    mcp: { acme_mcp: { url: 'https://example.test/eval', minTools: 2 } },
  };
  function withPluginServer(toolCount: number | null) {
    vi.mocked(probeAppServerStatus).mockResolvedValue({
      status: 'available',
      servers: [
        {
          label: 'glean',
          initialized: true,
          toolCount: 3,
          authStatus: 'bearerToken',
        },
        {
          label: 'acme_mcp',
          initialized: toolCount !== null,
          toolCount,
          authStatus: 'unsupported',
        },
      ],
    });
  }

  it('installs plugins after preflight and probes plugin servers under their own names', async () => {
    withPluginServer(2);
    const receipt = {
      name: 'acme',
      marketplace: 'mkt',
      version: '1.0.0',
      mcpServers: ['acme_mcp'],
    };
    vi.mocked(installCodexPlugins).mockResolvedValue([receipt]);
    const credentials = { 'acme/acme_mcp': TOKEN };
    const profile = await createProfile();
    await profile.beforeStart(
      setup,
      { MST_CHATGPT_MCP_TOKEN_0: TOKEN },
      [plugin],
      credentials
    );
    const [options] = vi.mocked(installCodexPlugins).mock.calls[0]!;
    expect(options).toMatchObject({
      codexHome: join(home, '.codex'),
      plugins: [plugin],
      credentials,
      reservedLabels: ['glean'],
    });
    expect(JSON.stringify(options.env)).not.toContain(TOKEN);
    expect(vi.mocked(probeAppServerStatus).mock.calls[0]![2]).toEqual([
      'glean',
      'acme_mcp',
    ]);
    expect(profile.readiness.plugins).toEqual([receipt]);
    expect(JSON.stringify(profile.readiness)).not.toContain(TOKEN);
    await profile.dispose();
  });

  it.each([1, null])(
    'fails closed when a plugin server has too few tools (%s)',
    async (toolCount) => {
      withPluginServer(toolCount);
      vi.mocked(installCodexPlugins).mockResolvedValue([]);
      const profile = await createProfile();
      await expect(
        profile.beforeStart(setup, { MST_CHATGPT_MCP_TOKEN_0: TOKEN }, [plugin])
      ).rejects.toMatchObject({ code: 'mcp_server_not_ready' });
      await profile.dispose();
    }
  );

  it('probes plugin servers when no direct MCP server is configured', async () => {
    vi.mocked(probeAppServerStatus).mockResolvedValue({
      status: 'available',
      servers: [
        {
          label: 'acme_mcp',
          initialized: true,
          toolCount: 2,
          authStatus: 'unsupported',
        },
      ],
    });
    vi.mocked(installCodexPlugins).mockResolvedValue([]);
    vi.mocked(checkMcpServers).mockResolvedValue([]);
    const profile = await createProfile();
    await profile.beforeStart({ ...setup, servers: [] }, {}, [plugin]);
    expect(vi.mocked(probeAppServerStatus).mock.calls[0]![2]).toEqual([
      'acme_mcp',
    ]);
    expect(profile.readiness.mcpStatus?.status).toBe('available');
    await profile.dispose();
  });

  it('fails setup when a plugin does not install', async () => {
    preflight('connected');
    vi.mocked(installCodexPlugins).mockRejectedValue(new Error('install'));
    const profile = await createProfile();
    await expect(
      profile.beforeStart(setup, { MST_CHATGPT_MCP_TOKEN_0: TOKEN }, [
        { name: 'acme', marketplace: { source: '/opt/plugins' } },
      ])
    ).rejects.toThrow('install');
    expect(profile.readiness.error).toBe('plugin_setup_failed');
    expect(probeAppServerStatus).not.toHaveBeenCalled();
    await profile.dispose();
  });

  it('stops after a failed login without any MCP connection', async () => {
    vi.mocked(loginWithApiKey).mockRejectedValue(
      new CodexSetupError('login_unverified')
    );
    const profile = await createProfile();
    await expect(profile.beforeStart(setup, {})).rejects.toMatchObject({
      code: 'login_unverified',
    });
    expect(profile.readiness).toMatchObject({
      login: 'failed',
      error: 'login_unverified',
    });
    expect(checkMcpServers).not.toHaveBeenCalled();
    expect(probeAppServerStatus).not.toHaveBeenCalled();
    await profile.dispose();
  });
});
