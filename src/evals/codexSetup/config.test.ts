import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCodexConfig,
  renderCodexConfig,
  resolveCodexSetup,
  type CodexExecutionPolicy,
} from './config.js';

const temporaryDirectories: string[] = [];
const GATEWAY = {
  id: 'mst_gateway',
  name: 'LLM gateway',
  baseUrl: 'https://gateway.example/openai/v1',
  authCommand: '/bin/cat',
  authArgs: ['/run/mst/token'],
  refreshIntervalMs: 60_000,
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Codex configuration rendering', () => {
  it('renders multiple stdio and HTTP MCP server blocks', () => {
    const output = renderCodexConfig([
      {
        transport: 'stdio',
        label: 'local_tools',
        command: '/tmp/mcp server',
        args: ['--name', 'a"b'],
        env: { TOKEN: 'value' },
      },
      {
        transport: 'http',
        label: 'remote',
        url: 'https://example.com/mcp',
        bearerTokenEnvVar: 'ACME_API_TOKEN',
      },
    ]);

    expect(output).toContain('[mcp_servers.local_tools]');
    expect(output).toContain('[mcp_servers.remote]');
    expect(output).toContain(String.raw`args = ["--name", "a\"b"]`);
    expect(output).toContain('bearer_token_env_var = "ACME_API_TOKEN"');
  });

  it('requires a name when selecting among multiple configs', () => {
    expect(() =>
      resolveCodexSetup({
        configs: [
          { name: 'read-only', servers: [] },
          { name: 'write', servers: [] },
        ],
      })
    ).toThrow('configName is required');
  });

  it('selects one named config and preserves its server set', () => {
    const resolved = resolveCodexSetup(
      {
        configs: [
          { name: 'read-only', servers: [] },
          {
            name: 'write',
            servers: [
              {
                transport: 'stdio',
                label: 'writer',
                command: 'writer-server',
              },
            ],
          },
        ],
      },
      'write'
    );

    expect(resolved.configName).toBe('write');
    expect(resolved.servers).toHaveLength(1);
    expect(resolved.content).toContain('[mcp_servers.writer]');
  });
});

describe('Codex configuration lifecycle', () => {
  it('preserves one existing account MCP server with an allowlist and restores the original bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-account-mcp-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original =
      '[mcp_servers.glean_default]\nurl = "https://example.test/mcp"\n' +
      'enabled_tools = ["search", "read_document", "write"]\n' +
      '[mcp_servers.glean_default.http_headers]\nAuthorization = "fixture-only"\n' +
      '[mcp_servers.other]\nurl = "https://other.test/mcp"\n';
    await writeFile(configPath, original, { mode: 0o600 });
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      {
        builtinToolPolicy: {
          webSearch: 'disabled',
          disabledPlugins: [],
          disabledFeatures: ['apps', 'in_app_browser'],
        },
        accountMcpPolicy: {
          serverName: 'glean_default',
          allowedTools: ['search', 'read_document'],
        },
      }
    );
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).toMatchObject({
      features: { apps: false, in_app_browser: false },
      mcp_servers: {
        glean_default: {
          url: 'https://example.test/mcp',
          enabled_tools: ['search', 'read_document'],
          http_headers: { Authorization: 'fixture-only' },
        },
      },
    });
    expect(installed.mcp_servers).not.toHaveProperty('other');
    expect(installation.serverCount).toBe(1);
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('leaves Work app settings intact while narrowing the selected MCP server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-local-apps-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original =
      'web_search = "live"\n' +
      '[mcp_servers.glean_default]\nurl = "https://example.test/mcp"\n' +
      '[apps.github]\nenabled = true\n';
    await writeFile(configPath, original, { mode: 0o600 });
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      {
        builtinToolPolicy: { disabledPlugins: [] },
        accountMcpPolicy: {
          serverName: 'glean_default',
          allowedTools: ['search'],
          limitAccountAppTools: true,
        },
      }
    );
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).toMatchObject({
      web_search: 'live',
      mcp_servers: { glean_default: { enabled_tools: ['search'] } },
      apps: {
        github: { enabled: true },
        glean_default: {
          enabled: true,
          default_tools_enabled: false,
          tools: { search: { enabled: true } },
        },
      },
    });
    expect(installed.apps).not.toHaveProperty('_default');
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('rejects missing, disabled or previously restricted account MCP tools without changing the config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-account-mcp-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const policy = { serverName: 'glean_default', allowedTools: ['search'] };
    for (const original of [
      '[mcp_servers.other]\nurl = "https://example.test/mcp"\n',
      '[mcp_servers.glean_default]\nurl = "https://example.test/mcp"\nenabled = false\n',
      '[mcp_servers.glean_default]\nurl = "https://example.test/mcp"\nenabled_tools = ["other"]\n',
      '[mcp_servers.glean_default]\nurl = "https://example.test/mcp"\ndisabled_tools = ["search"]\n',
      '[mcp_servers.glean_default]\nurl = "http://example.test/mcp"\n',
    ]) {
      await writeFile(configPath, original, { mode: 0o600 });
      await expect(
        installCodexConfig(
          { configPath, servers: [] },
          { accountMcpPolicy: policy }
        )
      ).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(original);
    }
  });

  it('rejects invalid or mixed account MCP policies', async () => {
    const { configPath } = await tempConfig();
    for (const accountMcpPolicy of [
      { serverName: '_default', allowedTools: ['search'] },
      { serverName: 'glean_default', allowedTools: [] },
      { serverName: 'glean_default', allowedTools: ['search', 'search'] },
      { serverName: 'glean_default', allowedTools: ['search\nmalicious'] },
    ])
      await expect(
        installCodexConfig({ configPath, servers: [] }, { accountMcpPolicy })
      ).rejects.toThrow('Invalid ChatGPT account MCP policy');
    await expect(
      installCodexConfig(
        {
          configPath,
          servers: [
            {
              transport: 'http',
              label: 'other',
              url: 'https://example.test/mcp',
            },
          ],
        },
        {
          accountMcpPolicy: {
            serverName: 'glean_default',
            allowedTools: ['search'],
          },
        }
      )
    ).rejects.toThrow('cannot mix eval servers');
  });

  it('installs a single account app and explicit tools, then restores the original bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-account-app-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original =
      '[features]\napps = false\n[apps.other]\nenabled = true\n[apps.glean.tools.send_email]\nenabled = true\n';
    await writeFile(configPath, original, { mode: 0o600 });
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      {
        builtinToolPolicy: {
          webSearch: 'disabled',
          disabledPlugins: [],
          disabledFeatures: ['in_app_browser'],
        },
        accountAppsPolicy: {
          appId: 'glean',
          allowedTools: ['search', 'read_document'],
        },
      }
    );
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).toMatchObject({
      features: { apps: true, in_app_browser: false },
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        glean: {
          enabled: true,
          default_tools_enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
          default_tools_approval_mode: 'prompt',
          tools: {
            search: { enabled: true },
            read_document: { enabled: true },
          },
        },
      },
    });
    expect(installed.apps).not.toHaveProperty('other');
    expect(installed.apps).not.toHaveProperty('glean.tools.send_email');
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('rejects invalid account app policies before touching the config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-account-app-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original = 'model = "test"\n';
    await writeFile(configPath, original, { mode: 0o600 });
    for (const accountAppsPolicy of [
      { appId: '_default', allowedTools: ['search'] },
      { appId: 'glean', allowedTools: [] },
      { appId: 'glean', allowedTools: ['search', 'search'] },
      { appId: 'glean', allowedTools: ['search\nmalicious'] },
    ]) {
      await expect(
        installCodexConfig({ configPath, servers: [] }, { accountAppsPolicy })
      ).rejects.toThrow('Invalid ChatGPT account app policy');
      expect(await readFile(configPath, 'utf8')).toBe(original);
    }
  });
  it('stages only the pinned local Glean MCP server and preserves Work apps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-local-glean-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original = '[apps.chatgpt_space]\nenabled = true\n';
    await writeFile(configPath, original, { mode: 0o600 });
    const options = {
      stagedLocalGlean: { allowedTools: ['search'] },
    };
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      options
    );
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed.mcp_servers).toEqual({
      glean_default: {
        url: 'https://scio-prod-be.glean.com/mcp/default',
        enabled: true,
        enabled_tools: ['search'],
        bearer_token_env_var: 'MST_CHATGPT_GLEAN_ACCESS_TOKEN',
        http_headers: { 'X-Glean-Metadata': 'mdm' },
      },
    });
    expect(installed.apps).toEqual({
      chatgpt_space: { enabled: true },
      glean_default: {
        enabled: true,
        default_tools_enabled: false,
        tools: { search: { enabled: true } },
      },
    });
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await expect(
      installCodexConfig(
        { configPath, servers: [] },
        {
          ...options,
          stagedLocalGlean: { allowedTools: ['search', 'search'] },
        }
      )
    ).rejects.toThrow('Invalid staged local Glean MCP policy');
  });
  it('installs requested model/effort alongside MCP and restores original settings exactly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-chatgpt-model-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original =
      '# keep original formatting\nmodel = "previous"\nmodel_reasoning_effort = "low"\n[desktop]\nfollowUpQueueMode = "steer"\n';
    await writeFile(configPath, original, { mode: 0o600 });
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      { model: 'test-chatgpt-model', reasoningEffort: 'medium' }
    );
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
      model: 'test-chatgpt-model',
      model_reasoning_effort: 'medium',
      desktop: { followUpQueueMode: 'steer' },
    });
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
  async function tempConfig(original?: string) {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-policy-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    if (original !== undefined)
      await writeFile(configPath, original, { mode: 0o600 });
    return { directory, configPath };
  }

  it('renders keyring, one trusted project, bearer env, and policy, then restores', async () => {
    const original =
      'approval_policy = "on-request"\ncli_auth_credentials_store = "file"\n[projects."/home/user"]\ntrust_level = "trusted"\n[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n[plugins."visualize@openai-bundled"]\nenabled = true\n';
    const { directory, configPath } = await tempConfig(original);
    const workspace = join(directory, 'workspace');
    const installation = await installCodexConfig(
      {
        configPath,
        servers: [
          {
            transport: 'http',
            label: 'acme',
            url: 'https://example.test/mcp',
            bearerTokenEnvVar: 'MST_CHATGPT_MCP_TOKEN_0',
          },
        ],
      },
      {
        credentialStore: 'keyring',
        trustedProject: workspace,
        executionPolicy: {
          approvalPolicy: 'never',
          sandboxMode: 'danger-full-access',
        },
        builtinToolPolicy: {
          disabledPlugins: ['unified-computer-use@openai-bundled'],
          webSearch: 'disabled',
          disabledFeatures: ['workspace_dependencies'],
        },
      }
    );
    expect(parse(await readFile(configPath, 'utf8'))).toEqual({
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      cli_auth_credentials_store: 'keyring',
      web_search: 'disabled',
      features: { workspace_dependencies: false },
      plugins: {
        'unified-computer-use@openai-bundled': { enabled: false },
        'visualize@openai-bundled': { enabled: true },
      },
      projects: { [workspace]: { trust_level: 'trusted' } },
      mcp_servers: {
        acme: {
          url: 'https://example.test/mcp',
          bearer_token_env_var: 'MST_CHATGPT_MCP_TOKEN_0',
        },
      },
    });
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('omits the execution and built-in tool policies unless requested', async () => {
    const { configPath } = await tempConfig();
    const installation = await installCodexConfig({ configPath, servers: [] });
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).not.toHaveProperty('approval_policy');
    expect(installed).not.toHaveProperty('sandbox_mode');
    expect(installed).not.toHaveProperty('web_search');
    expect(installed).not.toHaveProperty('plugins');
    await installation.restore();
  });

  it('renders a gateway model provider whose token comes from a command', async () => {
    const { configPath } = await tempConfig();
    const installation = await installCodexConfig(
      { configPath, servers: [] },
      { model: 'gpt-test', modelProvider: GATEWAY }
    );
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).toMatchObject({
      model: 'gpt-test',
      model_provider: 'mst_gateway',
      model_providers: {
        mst_gateway: {
          name: 'LLM gateway',
          base_url: 'https://gateway.example/openai/v1',
          wire_api: 'responses',
          auth: {
            command: '/bin/cat',
            args: ['/run/mst/token'],
            refresh_interval_ms: 60000,
          },
        },
      },
    });
    await installation.restore();
  });

  const invalidPolicy = {
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
  };
  it.each([
    ['executionPolicy', invalidPolicy, 'execution policy'],
    [
      'builtinToolPolicy',
      { disabledPlugins: ['a@b', 'a@b'], webSearch: 'disabled' },
      'built-in tool policy',
    ],
    [
      'builtinToolPolicy',
      { disabledPlugins: ['x"]\nenabled = true'], webSearch: 'disabled' },
      'built-in tool policy',
    ],
    [
      'builtinToolPolicy',
      { disabledPlugins: [], webSearch: 'live' },
      'built-in tool policy',
    ],
    [
      'builtinToolPolicy',
      {
        disabledPlugins: [],
        webSearch: 'disabled',
        disabledFeatures: ['x]\nenabled = true'],
      },
      'built-in tool policy',
    ],
    [
      'modelProvider',
      { ...GATEWAY, baseUrl: 'http://gateway.example/openai/v1' },
      'model provider',
    ],
    ['modelProvider', { ...GATEWAY, authCommand: 'cat' }, 'model provider'],
    ['modelProvider', { ...GATEWAY, id: 'x]\nenabled' }, 'model provider'],
    ['trustedProject', 'relative/workspace', 'trusted project'],
    ['trustedProject', '/', 'trusted project'],
    ['trustedProject', '/tmp/../tmp/x', 'trusted project'],
  ])('rejects unsafe %s %j before writing', async (key, value, message) => {
    const { directory, configPath } = await tempConfig();
    const options = { credentialStore: 'keyring', [key]: value } as {
      executionPolicy?: CodexExecutionPolicy;
    };
    await expect(
      installCodexConfig({ configPath, servers: [] }, options)
    ).rejects.toThrow(message);
    expect(await readdir(directory)).toEqual([]);
  });

  it('preserves app settings while replacing only the MCP server selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    await writeFile(
      configPath,
      '[desktop]\nfollowUpQueueMode = "steer"\n[mcp_servers.old]\ncommand = "old-server"\n'
    );
    const installation = await installCodexConfig({
      configPath,
      servers: [
        { transport: 'stdio', label: 'selected', command: 'new-server' },
      ],
    });
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed.desktop).toEqual({ followUpQueueMode: 'steer' });
    expect(Object.keys(installed.mcp_servers as object)).toEqual(['selected']);
    await installation.restore();
  });

  it('archives changed runtime bytes only with explicit lifecycle-owner opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original = '# original\nmodel = "test"\n';
    await writeFile(configPath, original, { mode: 0o640 });
    const installation = await installCodexConfig({ configPath, servers: [] });
    const changed = '[projects.example]\ntrust_level = "trusted"\n';
    await writeFile(configPath, changed);
    await installation.restore({ archiveChanges: true });
    expect(await readFile(configPath, 'utf8')).toBe(original);
    const archive = (await readdir(directory)).find((name) =>
      name.startsWith('config.toml.mst-runtime-')
    );
    expect(archive).toBeDefined();
    expect(await readFile(join(directory, archive!), 'utf8')).toBe(changed);
    expect((await stat(join(directory, archive!))).mode & 0o777).toBe(0o600);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it('restores an existing config byte-for-byte and preserves its mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const original = Buffer.from('# user config\nfoo = "bar"\n', 'utf8');
    await writeFile(configPath, original, { mode: 0o640 });

    const installation = await installCodexConfig({
      configPath,
      servers: [
        { transport: 'stdio', label: 'one', command: 'server-one' },
        { transport: 'stdio', label: 'two', command: 'server-two' },
      ],
    });
    expect(await readFile(configPath, 'utf8')).toContain('[mcp_servers.one]');
    await installation.restore();

    expect(await readFile(configPath)).toEqual(original);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it('removes an initially absent config after restoration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const installation = await installCodexConfig({
      configPath,
      servers: [],
    });

    await installation.restore();
    await expect(readFile(configPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed when the installed config changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mst-codex-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.toml');
    const installation = await installCodexConfig({
      configPath,
      servers: [],
    });
    await writeFile(configPath, 'changed by another process\n');

    await expect(installation.restore()).rejects.toThrow(
      'changed during the run'
    );
    await expect(
      readFile(`${configPath}.mst-lock/journal.json`)
    ).resolves.toBeTruthy();
  });
});
