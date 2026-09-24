import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { HostPluginSchema, installCodexPlugins } from './plugins.js';

const SHA = 'a'.repeat(40);
const TOKEN = 'eval-token-secret';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  );
});

/** A fake `codex` that performs `plugin marketplace add` and `plugin add` like the real CLI. */
async function fixture(options: { mcp?: unknown; failAdd?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mst-plugins-')));
  directories.push(home);
  await chmod(home, 0o700);
  await writeFile(
    join(home, 'config.toml'),
    '[mcp_servers.glean-eval]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "T"\n'
  );
  const root = join(home, 'plugins', 'cache', 'mkt', 'glean', '1.0.0');
  const script = join(home, 'fake-codex.sh');
  const mcp = JSON.stringify(
    options.mcp ?? {
      mcpServers: {
        glean_plugin: {
          command: 'node',
          args: ['./mcp/start.mjs'],
          cwd: '.',
          env: { ENABLE_HITL: 'true' },
        },
      },
    }
  );
  await writeFile(
    script,
    `#!/bin/sh
echo "$@" >> "${home}/calls.log"
case "$2" in
  marketplace) echo 'warning: noise {not json'; echo '{"marketplaceName":"mkt","alreadyAdded":false}';;
  add) ${options.failAdd ? 'exit 3' : ''}
    mkdir -p "${root}/.codex-plugin"
    echo '{"name":"glean","version":"1.0.0"}' > "${root}/.codex-plugin/plugin.json"
    echo '${mcp}' > "${root}/.mcp.json"
    echo '{"installedPath":"${root}"}';;
esac
`
  );
  await chmod(script, 0o700);
  return { home, root, script };
}

const plugin = {
  name: 'glean',
  marketplace: { source: 'gleanwork/codex-plugins', ref: SHA },
  mcp: {
    server: 'glean_plugin',
    replaces: 'glean-eval',
    adapter: 'glean' as const,
  },
};

describe('installCodexPlugins', () => {
  it('installs pinned plugins and runs the plugin server under the replaced label', async () => {
    const { home, root, script } = await fixture();
    const receipts = await installCodexPlugins({
      codexPath: script,
      env: { PATH: '/usr/bin:/bin' },
      codexHome: home,
      plugins: [plugin],
      replaced: [
        { label: 'glean-eval', url: 'https://example.test/mcp', token: TOKEN },
      ],
    });
    expect(receipts).toEqual([
      {
        name: 'glean',
        marketplace: 'mkt',
        version: '1.0.0',
        ref: SHA,
        mcpServer: 'glean_plugin',
        replaces: 'glean-eval',
      },
    ]);
    expect(await readFile(join(home, 'calls.log'), 'utf8')).toBe(
      `plugin marketplace add gleanwork/codex-plugins --ref ${SHA} --json\nplugin add glean@mkt --json\n`
    );
    const config = parse(await readFile(join(home, 'config.toml'), 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    const data = join(home, 'mst-plugin-data', 'glean');
    expect(config.mcp_servers['glean-eval']).toEqual({
      command: 'node',
      args: [join(root, 'mcp', 'start.mjs')],
      cwd: root,
      env: {
        ENABLE_HITL: 'false',
        GLEAN_MCP_SERVER_URL: 'https://example.test/mcp',
        CLAUDE_PLUGIN_DATA: data,
      },
    });
    expect(config.mcp_servers.glean_plugin).toMatchObject({
      enabled: false,
      command: 'node',
    });
    // The credential never enters config.toml or receipts; it is a private file.
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain(
      TOKEN
    );
    expect(JSON.stringify(receipts)).not.toContain(TOKEN);
    const credentials = join(data, 'mcp-credentials.json');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(data)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toEqual({
      tokens: { access_token: TOKEN, token_type: 'Bearer' },
    });
  });

  it('installs skills-only plugins without touching MCP servers', async () => {
    const { home, script } = await fixture();
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    const [receipt] = await installCodexPlugins({
      codexPath: script,
      env: {},
      codexHome: home,
      plugins: [{ name: 'glean', marketplace: plugin.marketplace }],
      replaced: [],
    });
    expect(receipt).not.toHaveProperty('replaces');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
  });

  it.each([
    ['a failed install', { failAdd: true }, plugin, 'plugin_install_failed'],
    [
      'an unknown replaced label',
      {},
      { ...plugin, mcp: { ...plugin.mcp, replaces: 'other' } },
      'plugin_mcp_invalid',
    ],
    [
      'a missing plugin server',
      {},
      { ...plugin, mcp: { ...plugin.mcp, server: 'missing' } },
      'plugin_mcp_invalid',
    ],
    [
      'a server cwd outside the plugin',
      {
        mcp: {
          mcpServers: { glean_plugin: { command: 'node', cwd: '../..' } },
        },
      },
      plugin,
      'plugin_mcp_invalid',
    ],
    [
      'an HTTP plugin server',
      {
        mcp: {
          mcpServers: { glean_plugin: { command: 'x', url: 'https://x.test' } },
        },
      },
      plugin,
      'plugin_mcp_invalid',
    ],
  ])('fails closed on %s', async (_kind, arrange, selected, code) => {
    const { home, script } = await fixture(arrange);
    await expect(
      installCodexPlugins({
        codexPath: script,
        env: {},
        codexHome: home,
        plugins: [selected],
        replaced: [
          {
            label: 'glean-eval',
            url: 'https://example.test/mcp',
            token: TOKEN,
          },
        ],
      })
    ).rejects.toMatchObject({ code });
  });

  it('requires a full commit SHA for Git marketplaces', () => {
    expect(
      HostPluginSchema.safeParse({ ...plugin, marketplace: { source: 'o/r' } })
        .success
    ).toBe(false);
    expect(
      HostPluginSchema.safeParse({
        ...plugin,
        marketplace: { source: 'o/r', ref: 'main' },
      }).success
    ).toBe(false);
    expect(
      HostPluginSchema.safeParse({
        ...plugin,
        marketplace: { source: '/opt/plugins' },
      }).success
    ).toBe(true);
  });

  it('rejects duplicate plugins before running anything', async () => {
    const { home, script } = await fixture();
    await mkdir(join(home, 'x'));
    await expect(
      installCodexPlugins({
        codexPath: script,
        env: {},
        codexHome: home,
        plugins: [plugin, plugin],
        replaced: [],
      })
    ).rejects.toMatchObject({ code: 'plugin_invalid' });
    await expect(stat(join(home, 'calls.log'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
