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
        bearerTokenEnvVar: 'GLEAN_API_TOKEN',
      },
    ]);

    expect(output).toContain('[mcp_servers.local_tools]');
    expect(output).toContain('[mcp_servers.remote]');
    expect(output).toContain(String.raw`args = ["--name", "a\"b"]`);
    expect(output).toContain('bearer_token_env_var = "GLEAN_API_TOKEN"');
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
      'approval_policy = "on-request"\ncli_auth_credentials_store = "file"\n[projects."/home/user"]\ntrust_level = "trusted"\n';
    const { directory, configPath } = await tempConfig(original);
    const workspace = join(directory, 'workspace');
    const installation = await installCodexConfig(
      {
        configPath,
        servers: [
          {
            transport: 'http',
            label: 'glean',
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
      }
    );
    expect(parse(await readFile(configPath, 'utf8'))).toEqual({
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      cli_auth_credentials_store: 'keyring',
      projects: { [workspace]: { trust_level: 'trusted' } },
      mcp_servers: {
        glean: {
          url: 'https://example.test/mcp',
          bearer_token_env_var: 'MST_CHATGPT_MCP_TOKEN_0',
        },
      },
    });
    await installation.restore();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('omits the execution policy unless requested', async () => {
    const { configPath } = await tempConfig();
    const installation = await installCodexConfig({ configPath, servers: [] });
    const installed = parse(await readFile(configPath, 'utf8'));
    expect(installed).not.toHaveProperty('approval_policy');
    expect(installed).not.toHaveProperty('sandbox_mode');
    await installation.restore();
  });

  const invalidPolicy = {
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
  };
  it.each([
    ['executionPolicy', invalidPolicy, 'execution policy'],
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
