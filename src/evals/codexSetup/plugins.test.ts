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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexPluginReadinessTargets,
  installCodexPlugins,
  type HostPlugin,
} from './plugins.js';

const SHA = 'a'.repeat(40);
const TOKEN = 'eval-token-secret';
const URL = 'https://example.test/mcp/eval';
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
    '[mcp_servers.direct]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "T"\n'
  );
  const root = join(home, 'plugins', 'cache', 'mkt', 'acme', '1.0.0');
  const script = join(home, 'fake-codex.sh');
  const mcp = JSON.stringify(
    options.mcp ?? {
      mcpServers: {
        acme_mcp: {
          command: 'node',
          args: ['./server/start.mjs', '--stdio'],
          cwd: '.',
          env: { ACME_PROMPTS: 'true', KEEP: 'yes' },
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
    echo '{"name":"acme","version":"1.0.0"}' > "${root}/.codex-plugin/plugin.json"
    echo '${mcp}' > "${root}/.mcp.json"
    echo '{"installedPath":"${root}"}';;
esac
`
  );
  await chmod(script, 0o700);
  return { home, root, script };
}

/** A generic fake plugin: nothing here is known to MST. */
const plugin: HostPlugin = {
  name: 'acme',
  marketplace: { source: 'acme/plugins', ref: SHA },
  mcp: {
    acme_mcp: {
      url: URL,
      auth: { accessTokenEnv: 'ACME_TOKEN' },
      minTools: 2,
      env: {
        ACME_URL: '${url}',
        ACME_DATA: '${dataDir}',
        ACME_PROMPTS: 'false',
      },
      files: {
        'creds.json': {
          tokens: { access_token: '${bearerToken}', token_type: 'Bearer' },
        },
      },
    },
  },
};
const credentials = { 'acme/acme_mcp': TOKEN };

function install(
  script: string,
  home: string,
  plugins: HostPlugin[],
  extra: Partial<Parameters<typeof installCodexPlugins>[0]> = {}
) {
  return installCodexPlugins({
    codexPath: script,
    env: { PATH: '/usr/bin:/bin' },
    codexHome: home,
    plugins,
    credentials,
    ...extra,
  });
}

describe('installCodexPlugins', () => {
  it('installs a pinned plugin and overrides its own MCP server with a complete definition', async () => {
    const { home, root, script } = await fixture();
    const receipts = await install(script, home, [plugin], {
      reservedLabels: ['direct'],
    });
    expect(receipts).toEqual([
      {
        name: 'acme',
        marketplace: 'mkt',
        version: '1.0.0',
        ref: SHA,
        mcpServers: ['acme_mcp'],
      },
    ]);
    expect(await readFile(join(home, 'calls.log'), 'utf8')).toBe(
      `plugin marketplace add acme/plugins --ref ${SHA} --json\nplugin add acme@mkt --json\n`
    );
    const raw = await readFile(join(home, 'config.toml'), 'utf8');
    const config = parse(raw) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    const data = join(home, 'mst-plugin-data', 'acme', 'acme_mcp');
    // Own name, full stdio table (command/args/cwd), env merged over the plugin's.
    expect(config.mcp_servers.acme_mcp).toEqual({
      command: 'node',
      args: [join(root, 'server', 'start.mjs'), '--stdio'],
      cwd: root,
      env: {
        ACME_PROMPTS: 'false',
        KEEP: 'yes',
        ACME_URL: URL,
        ACME_DATA: data,
      },
    });
    expect(config.mcp_servers.direct).toMatchObject({
      url: 'https://example.test/mcp',
    });
    // The credential never enters config.toml or receipts; it is a private file.
    expect(raw).not.toContain(TOKEN);
    expect(JSON.stringify(receipts)).not.toContain(TOKEN);
    const file = join(data, 'creds.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    for (const dir of [data, join(home, 'mst-plugin-data')])
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      tokens: { access_token: TOKEN, token_type: 'Bearer' },
    });
    expect(codexPluginReadinessTargets([plugin])).toEqual([
      { label: 'acme_mcp', minTools: 2 },
    ]);
  });

  it('installs skills-only plugins without touching MCP servers', async () => {
    const { home, script } = await fixture();
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    const [receipt] = await install(script, home, [
      { name: 'acme', marketplace: plugin.marketplace },
    ]);
    expect(receipt).not.toHaveProperty('mcpServers');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
    expect(codexPluginReadinessTargets([])).toEqual([]);
  });

  it.each([
    ['a failed install', { failAdd: true }, plugin, 'plugin_install_failed'],
    [
      'a missing plugin server',
      {},
      { ...plugin, mcp: { missing: plugin.mcp!.acme_mcp! } },
      'plugin_mcp_invalid',
    ],
    [
      'a server cwd outside the plugin',
      { mcp: { mcpServers: { acme_mcp: { command: 'node', cwd: '../..' } } } },
      plugin,
      'plugin_mcp_invalid',
    ],
    [
      'an HTTP plugin server',
      {
        mcp: {
          mcpServers: { acme_mcp: { command: 'x', url: 'https://x.test' } },
        },
      },
      plugin,
      'plugin_mcp_invalid',
    ],
    [
      'an unexpanded host placeholder',
      {
        mcp: {
          mcpServers: {
            acme_mcp: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x'] },
          },
        },
      },
      plugin,
      'plugin_mcp_invalid',
    ],
  ])('fails closed on %s', async (_kind, arrange, selected, code) => {
    const { home, script } = await fixture(arrange);
    await expect(install(script, home, [selected])).rejects.toMatchObject({
      code,
    });
  });

  it('fails closed without the resolved credential', async () => {
    const { home, script } = await fixture();
    await expect(
      install(script, home, [plugin], { credentials: {} })
    ).rejects.toMatchObject({ code: 'plugin_credential_missing' });
  });

  it('never follows a symlinked plugin data directory', async () => {
    const { home, script } = await fixture();
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(home, 'mst-plugin-data'));
    await expect(install(script, home, [plugin])).rejects.toMatchObject({
      code: 'plugin_data_unsafe',
    });
    await expect(stat(join(elsewhere, 'acme'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a plugin server that shadows a direct MCP label before running anything', async () => {
    const { home, script } = await fixture();
    await expect(
      install(script, home, [plugin], { reservedLabels: ['acme_mcp'] })
    ).rejects.toMatchObject({ code: 'plugin_invalid' });
    await expect(stat(join(home, 'calls.log'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('records the ref of a pre-staged local marketplace without passing it to the CLI', async () => {
    const { home, script } = await fixture();
    const [receipt] = await install(script, home, [
      {
        name: 'acme',
        marketplace: { source: '/opt/scio/app/plugins/acme', ref: SHA },
      },
    ]);
    expect(receipt!.ref).toBe(SHA);
    expect(await readFile(join(home, 'calls.log'), 'utf8')).toContain(
      'plugin marketplace add /opt/scio/app/plugins/acme --json\n'
    );
  });

  it('rejects duplicate plugins before running anything', async () => {
    const { home, script } = await fixture();
    await expect(install(script, home, [plugin, plugin])).rejects.toMatchObject(
      { code: 'plugin_invalid' }
    );
    await expect(stat(join(home, 'calls.log'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
