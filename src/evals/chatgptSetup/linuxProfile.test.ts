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
import { checkMcpServers } from '../mcpReadiness.js';
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

beforeEach(async () => {
  vi.resetAllMocks();
  home = await realpath(await mkdtemp(join(tmpdir(), 'mst-linux-profile-')));
  env = linuxEnvironment(home);
  for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'MST_CHATGPT_EVIDENCE_DIR'])
    await mkdir(env[key]!, { mode: 0o700 });
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const key of ['MST_CHATGPT_APP_PATH', 'MST_CHATGPT_CODEX_PATH']) {
    env[key] = join(bin, key);
    await writeFile(env[key], '#!/bin/sh\n', { mode: 0o700 });
  }
  vi.mocked(loginWithApiKey).mockResolvedValue({
    loginVerified: true,
    method: 'api-key',
  });
  vi.mocked(checkMcpServers).mockResolvedValue([
    { label: 'glean', status: 'connected', toolCount: 3, elapsedMs: 1 },
  ]);
  vi.mocked(probeAppServerStatus).mockResolvedValue({
    status: 'available',
    servers: [
      {
        label: 'glean',
        initialized: true,
        toolCount: 3,
        authStatus: 'bearerToken',
      },
    ],
    hostTools: {
      unconfiguredServerWithTools: false,
      disabled: [{ label: 'cua_repl', present: false, toolCount: null }],
    },
  });
});
afterEach(async () => {
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
    expect(Object.keys(parsed.session).sort()).toEqual(
      [
        'AT_SPI_BUS_ADDRESS',
        'CODEX_HOME',
        'DBUS_SESSION_BUS_ADDRESS',
        'DISPLAY',
        'GNOME_KEYRING_CONTROL',
        'HOME',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_RUNTIME_DIR',
        'XDG_STATE_HOME',
      ].sort()
    );
    expect(JSON.stringify(parsed.session)).not.toContain('secret-sentinel');
  });

  it.each([
    ['HOME', undefined],
    ['HOME', 'relative'],
    ['HOME', '/'],
    ['TMPDIR', '/tmp/../tmp/x'],
    ['XDG_CONFIG_HOME', '/elsewhere/.config'],
    ['DBUS_SESSION_BUS_ADDRESS', 'tcp:host=x'],
    ['AT_SPI_BUS_ADDRESS', undefined],
    ['DISPLAY', undefined],
    ['GNOME_KEYRING_CONTROL', undefined],
    ['MST_CHATGPT_APP_PATH', undefined],
    ['MST_CHATGPT_CODEX_PATH', 'codex'],
    ['MST_CHATGPT_API_KEY_FILE', undefined],
    ['MST_CHATGPT_EVIDENCE_DIR', undefined],
    ['CODEX_HOME', '/home/user/.codex'],
  ])('rejects %s=%s with a fixed code', (key, value) => {
    const next = { ...env, [key]: value };
    if (value === undefined) delete next[key];
    expect(() => readLinuxChatgptEnvironment(next)).toThrow(
      `environment_invalid: ${key}`
    );
  });
});

describe('fresh MST-owned Linux profile', () => {
  it('requires Linux', async () => {
    await expect(
      createLinuxChatgptProfile(readLinuxChatgptEnvironment(env), 'darwin')
    ).rejects.toMatchObject({ code: 'linux_required' });
  });

  it('creates CODEX_HOME exclusively and one empty private workspace', async () => {
    const profile = await createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(env),
      'linux'
    );
    expect((await stat(join(home, '.codex'))).mode & 0o777).toBe(0o700);
    const workspace = profile.install.trustedProject!;
    expect(
      workspace.startsWith(join(home, 'tmp', 'mst-chatgpt-workspace-'))
    ).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(profile).toMatchObject({
      configPath: join(home, '.codex', 'config.toml'),
      install: {
        credentialStore: 'keyring',
        disabledHostTools: [
          { kind: 'plugin', id: 'computer-use@openai-bundled' },
          { kind: 'mcpServer', label: 'cua_repl' },
        ],
      },
      evidenceDir: join(home, 'evidence'),
    });
    await profile.dispose();
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['existing .codex', 'home_not_fresh'],
    ['group-readable HOME', 'home_unsafe'],
    ['non-empty evidence', 'evidence_dir_unsafe'],
    ['non-executable app', 'app_path_invalid'],
  ])('fails closed on %s', async (kind, code) => {
    if (kind === 'existing .codex') await mkdir(join(home, '.codex'));
    if (kind === 'group-readable HOME') await chmod(home, 0o750);
    if (kind === 'non-empty evidence')
      await writeFile(join(env.MST_CHATGPT_EVIDENCE_DIR!, 'x'), '');
    if (kind === 'non-executable app')
      await chmod(env.MST_CHATGPT_APP_PATH!, 0o600);
    await expect(
      createLinuxChatgptProfile(readLinuxChatgptEnvironment(env), 'linux')
    ).rejects.toMatchObject({ code });
    await chmod(home, 0o700);
  });

  it('logs in without tokens, then preflights and probes MCP with tokens', async () => {
    const profile = await createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(env),
      'linux'
    );
    await profile.beforeStart(setup, {
      MST_CHATGPT_MCP_TOKEN_0: 'tok-sentinel',
    });
    const [codex, loginEnv, keyFile] =
      vi.mocked(loginWithApiKey).mock.calls[0]!;
    expect(codex).toBe(env.MST_CHATGPT_CODEX_PATH);
    expect(keyFile).toBe(env.MST_CHATGPT_API_KEY_FILE);
    expect(loginEnv).toMatchObject({
      CODEX_HOME: join(home, '.codex'),
      PATH: '/usr/bin:/bin',
    });
    expect(JSON.stringify(loginEnv)).not.toContain('tok-sentinel');
    expect(vi.mocked(checkMcpServers).mock.calls[0]![0]).toEqual([
      {
        transport: 'http',
        label: 'glean',
        serverUrl: 'https://example.test/mcp',
        auth: { accessToken: 'tok-sentinel' },
      },
    ]);
    const [, probeEnv, labels] = vi.mocked(probeAppServerStatus).mock.calls[0]!;
    expect(probeEnv.MST_CHATGPT_MCP_TOKEN_0).toBe('tok-sentinel');
    expect(labels).toEqual(['glean']);
    expect(vi.mocked(probeAppServerStatus).mock.calls[0]![3]).toEqual([
      'cua_repl',
    ]);
    expect(profile.readiness).toMatchObject({
      hostToolPolicy: {
        disabled: ['computer-use@openai-bundled', 'cua_repl'],
      },
      login: 'verified',
      mcpPreflight: [{ status: 'connected', toolCount: 3 }],
      mcpStatus: { status: 'available' },
    });
    expect(JSON.stringify(profile.readiness)).not.toContain('tok-sentinel');
    await profile.dispose();
  });

  it.each([
    ['preflight', 'mcp_preflight_failed'],
    ['zero tools', 'mcp_preflight_failed'],
    ['status unavailable', 'mcp_status_unavailable'],
    ['not initialized', 'mcp_server_not_ready'],
    ['wrong auth', 'mcp_server_not_ready'],
    ['cua_repl with tools', 'host_tool_policy_unenforced'],
  ])('fails before app start on %s', async (kind, code) => {
    if (kind === 'preflight')
      vi.mocked(checkMcpServers).mockResolvedValue([
        { label: 'glean', status: 'failed', elapsedMs: 1, error: 'http_401' },
      ]);
    if (kind === 'zero tools')
      vi.mocked(checkMcpServers).mockResolvedValue([
        { label: 'glean', status: 'connected', toolCount: 0, elapsedMs: 1 },
      ]);
    if (kind === 'status unavailable')
      vi.mocked(probeAppServerStatus).mockResolvedValue({
        status: 'unavailable',
        reason: 'timeout',
      });
    if (kind === 'not initialized' || kind === 'wrong auth')
      vi.mocked(probeAppServerStatus).mockResolvedValue({
        status: 'available',
        servers: [
          kind === 'wrong auth'
            ? {
                label: 'glean',
                initialized: true,
                toolCount: 3,
                authStatus: 'notLoggedIn',
              }
            : {
                label: 'glean',
                initialized: false,
                toolCount: null,
                authStatus: 'unknown',
              },
        ],
        hostTools: {
          unconfiguredServerWithTools: false,
          disabled: [{ label: 'cua_repl', present: false, toolCount: null }],
        },
      });
    if (kind === 'cua_repl with tools')
      vi.mocked(probeAppServerStatus).mockResolvedValue({
        status: 'available',
        servers: [
          {
            label: 'glean',
            initialized: true,
            toolCount: 3,
            authStatus: 'bearerToken',
          },
        ],
        hostTools: {
          unconfiguredServerWithTools: true,
          disabled: [{ label: 'cua_repl', present: true, toolCount: 1 }],
        },
      });
    const profile = await createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(env),
      'linux'
    );
    await expect(
      profile.beforeStart(setup, { MST_CHATGPT_MCP_TOKEN_0: 'tok-sentinel' })
    ).rejects.toMatchObject({ code });
    expect(profile.readiness.error).toBe(code);
    await profile.dispose();
  });

  it('verifies the host tool policy even without configured MCP servers', async () => {
    vi.mocked(checkMcpServers).mockResolvedValue([]);
    vi.mocked(probeAppServerStatus).mockResolvedValue({
      status: 'available',
      servers: [],
      hostTools: {
        unconfiguredServerWithTools: true,
        disabled: [{ label: 'cua_repl', present: true, toolCount: 2 }],
      },
    });
    const profile = await createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(env),
      'linux'
    );
    await expect(
      profile.beforeStart({ ...setup, servers: [] }, {})
    ).rejects.toMatchObject({ code: 'host_tool_policy_unenforced' });
    expect(probeAppServerStatus).toHaveBeenCalledOnce();
    await profile.dispose();
  });

  it('stops after a failed login without any MCP connection', async () => {
    const { CodexSetupError } = await import('../codexSetup/native.js');
    vi.mocked(loginWithApiKey).mockRejectedValue(
      new CodexSetupError('login_unverified')
    );
    const profile = await createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(env),
      'linux'
    );
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
