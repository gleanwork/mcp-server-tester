import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostPluginsSchema,
  assertCoworkHostPlugins,
  coworkBlockedMcpEntries,
  hostStdioFileContents,
  hostStdioReadinessConfig,
  hostStdioServers,
  materializeHostStdioFiles,
  resolveHostStdioCredentials,
  resolveHostStdioServer,
  type HostPlugin,
} from './hostPlugins.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  coworkManagedPluginSettings,
  coworkMcpSettingsMatch,
} from './cowork/managedSettings.js';

const SHA = 'a'.repeat(40);
const plugin: HostPlugin = {
  name: 'fake',
  marketplace: { source: 'acme/plugins', ref: SHA },
  blockMcpServers: ['fake_plugin'],
};
const server = {
  transport: 'stdio',
  label: 'fake-eval',
  command: 'node',
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
const paths = { pluginRoots: { fake: '/opt/plugins/fake' }, dataRoot: '/d' };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

describe('host-resolved stdio eval servers', () => {
  it('resolves ${pluginRoot:...}, ${url}, and ${dataDir}; never a token outside files', () => {
    const [parsed] = hostStdioServers([server], [plugin]);
    expect(parsed).toMatchObject({
      label: 'fake-eval',
      minTools: 4,
      pluginRoots: ['fake'],
      usesDataDir: true,
    });
    const launch = resolveHostStdioServer(parsed!, paths);
    expect(launch).toEqual({
      command: 'node',
      args: ['/opt/plugins/fake/mcp/start.mjs'],
      env: {
        FAKE_MCP_URL: 'https://example.test/mcp/default/eval',
        FAKE_PLUGIN_DATA: '/d/fake-eval',
        ENABLE_HITL: 'false',
      },
      dataDir: '/d/fake-eval',
    });
    expect(JSON.stringify(launch)).not.toContain('secret');
    expect(hostStdioFileContents(parsed!, paths, 'secret')).toEqual({
      'creds.json': {
        tokens: { access_token: 'secret', token_type: 'Bearer' },
      },
    });
    const readiness = hostStdioReadinessConfig(parsed!, paths);
    expect(readiness).toMatchObject({
      transport: 'stdio',
      label: 'fake-eval',
      inheritEnv: false,
      minTools: 4,
      env: launch.env,
    });
    expect(readiness).not.toHaveProperty('files');
    expect(readiness).not.toHaveProperty('url');
  });

  it('defaults minTools to 1 and skips non-stdio servers', () => {
    const http = {
      transport: 'http',
      label: 'h',
      serverUrl: 'https://e.test/eval',
    } as MCPConfig;
    const minimal = {
      transport: 'stdio',
      label: 'x',
      command: '/bin/x',
      args: ['--url', '${url}'],
      url: 'https://e.test/eval',
    } as MCPConfig;
    const parsed = hostStdioServers([http, minimal]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ minTools: 1, usesDataDir: false });
  });

  it.each([
    ['url placeholder without a url', { url: undefined }],
    ['a token in env', { env: { X: '${bearerToken}', U: '${url}' } }],
    ['a token in args', { args: ['${bearerToken}', '${url}'] }],
    ['an unknown placeholder', { args: ['${HOME}', '${url}'] }],
    ['a malformed placeholder', { args: ['${url', '${url}'] }],
    ['a token in cwd', { cwd: '${bearerToken}' }],
    ['an unknown cwd placeholder', { cwd: '${HOME}' }],
    ['unknown declarations', { unsupported: true }],
    ['ambient environment inheritance', { inheritEnv: true }],
    ['unsupported capabilities', { capabilities: {} }],
    ['NUL in args', { args: ['bad\0arg'] }],
    ['a placeholder inside url', { url: 'https://e.test/${unknown}' }],
    ['url not used in the launch', { env: {}, args: [] }],
    ['a token without auth', { auth: undefined }],
    ['a nested file path', { files: { '../x': {} } }],
    ['a label unsafe for config keys', { label: 'bad label' }],
    ['a zero tool minimum', { minTools: 0 }],
    ['plain HTTP url', { url: 'http://example.test/eval' }],
    ['inheritEnv', { inheritEnv: true }],
  ])('rejects %s', (_kind, change) => {
    expect(() =>
      hostStdioServers([{ ...server, ...change } as MCPConfig], [plugin])
    ).toThrow(expect.objectContaining({ code: 'mcp_server_invalid' }));
  });

  it('accepts plain stdio with global default labels and declared env only', () => {
    const configs: MCPConfig[] = [
      { transport: 'http', serverUrl: 'https://e.test/mcp' },
      {
        transport: 'stdio',
        command: '/bin/tool',
        args: ['--name', 'two words'],
        env: { DECLARED: 'value' },
        inheritEnv: false,
        connectTimeoutMs: 1234,
        requestTimeoutMs: 2345,
        callTimeoutMs: 3456,
        quiet: false,
      },
      { transport: 'stdio', command: '/bin/other' },
    ];
    const parsed = hostStdioServers(configs);
    expect(parsed.map((entry) => entry.label)).toEqual([
      'server-2',
      'server-3',
    ]);
    expect(parsed[0]).toMatchObject({
      minTools: 1,
      pluginRoots: [],
      usesDataDir: false,
    });
    expect(parsed[0]).not.toHaveProperty('url');
    expect(hostStdioReadinessConfig(parsed[0]!, {})).toEqual({
      transport: 'stdio',
      label: 'server-2',
      command: '/bin/tool',
      args: ['--name', 'two words'],
      env: { DECLARED: 'value' },
      inheritEnv: false,
      minTools: 1,
      connectTimeoutMs: 1234,
      requestTimeoutMs: 2345,
      callTimeoutMs: 3456,
      quiet: false,
    });
    expect(resolveHostStdioServer(parsed[1]!, {})).toEqual({
      command: '/bin/other',
      args: [],
      env: {},
    });
    expect(() =>
      hostStdioServers([
        ...configs,
        { transport: 'stdio', label: 'server-2', command: '/bin/duplicate' },
      ])
    ).toThrow(expect.objectContaining({ code: 'mcp_server_invalid' }));
    expect(() =>
      hostStdioServers([
        {
          transport: 'http',
          label: 'server-2',
          serverUrl: 'https://e.test/mcp',
        },
        configs[1]!,
      ])
    ).toThrow(expect.objectContaining({ code: 'mcp_server_invalid' }));
  });

  it('uses identical positional cwd launches for managed settings and readiness', () => {
    const configs: MCPConfig[] = [
      {
        transport: 'stdio',
        command: '/opt/tool with spaces',
        args: ['a; echo unsafe', '$(false)', 'quote\'"'],
        cwd: "/opt/work ' $(false)",
        env: { EXPLICIT: 'value' },
      },
    ];
    const [parsed] = hostStdioServers(configs);
    const launch = resolveHostStdioServer(parsed!, {});
    expect(launch).toEqual({
      command: '/bin/sh',
      args: [
        '-c',
        'cd -- "$1" && shift && exec "$@"',
        'mst-cowork',
        "/opt/work ' $(false)",
        '/opt/tool with spaces',
        'a; echo unsafe',
        '$(false)',
        'quote\'"',
      ],
      env: { EXPLICIT: 'value' },
    });
    const settings = coworkManagedPluginSettings({ servers: configs });
    expect(settings.managedMcpServers).toEqual([
      { name: 'server-1', transport: 'stdio', ...launch },
    ]);
    expect(hostStdioReadinessConfig(parsed!, {})).toMatchObject(launch);
    expect(
      coworkMcpSettingsMatch(
        {
          ...settings,
          allowManagedMcpServersOnly: true,
        },
        { servers: configs }
      )
    ).toBe(true);
    expect(
      coworkMcpSettingsMatch(
        {
          ...settings,
          allowManagedMcpServersOnly: true,
          managedMcpServers: [
            { ...settings.managedMcpServers[0], cwd: '/ignored' },
          ],
        },
        { servers: configs }
      )
    ).toBe(false);
  });

  it('resolves cwd placeholders and rejects unsafe or relative cwd paths', () => {
    for (const cwd of ['${pluginRoot:fake}', '${dataDir}']) {
      const [parsed] = hostStdioServers(
        [{ ...server, cwd } as MCPConfig],
        [plugin]
      );
      expect(resolveHostStdioServer(parsed!, paths).args[3]).toBe(
        cwd === '${dataDir}' ? '/d/fake-eval' : '/opt/plugins/fake'
      );
    }
    for (const cwd of ['relative', '/opt/../tmp', '/tmp\npath']) {
      const [parsed] = hostStdioServers([
        { transport: 'stdio', command: 'node', cwd },
      ]);
      expect(() => resolveHostStdioServer(parsed!, {})).toThrow(
        expect.objectContaining({ code: 'mcp_server_invalid' })
      );
    }
  });

  it('rejects an undeclared plugin root, duplicate labels, and missing paths', () => {
    expect(() => hostStdioServers([server], [])).toThrow(
      expect.objectContaining({ code: 'mcp_server_invalid' })
    );
    expect(() => hostStdioServers([server, server], [plugin])).toThrow(
      expect.objectContaining({ code: 'mcp_server_invalid' })
    );
    const [parsed] = hostStdioServers([server], [plugin]);
    for (const bad of [
      {},
      { ...paths, pluginRoots: {} },
      { ...paths, dataRoot: 'relative' },
      { ...paths, pluginRoots: { fake: '/opt/../etc' } },
      { ...paths, dataRoot: '/' },
    ])
      expect(() => resolveHostStdioServer(parsed!, bad)).toThrow(
        expect.objectContaining({ code: 'mcp_server_invalid' })
      );
  });

  it('resolves credentials from env and fails closed when missing', () => {
    const parsed = hostStdioServers([server], [plugin]);
    expect(resolveHostStdioCredentials(parsed, { FAKE_TOKEN: 't' })).toEqual({
      'fake-eval': 't',
    });
    for (const env of [{}, { FAKE_TOKEN: '' }, { FAKE_TOKEN: 'a b' }])
      expect(() => resolveHostStdioCredentials(parsed, env)).toThrow(
        expect.objectContaining({ code: 'plugin_credential_missing' })
      );
  });

  it('writes private files (0700/0600, exclusive) for TS callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mst-stdio-'));
    dirs.push(root);
    const [parsed] = hostStdioServers([server], [plugin]);
    const local = { ...paths, dataRoot: root };
    const dataDir = await materializeHostStdioFiles({
      server: parsed!,
      paths: local,
      token: 'tok',
    });
    expect(dataDir).toBe(join(root, 'fake-eval'));
    expect((await stat(dataDir!)).mode & 0o777).toBe(0o700);
    const file = join(dataDir!, 'creds.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      tokens: { access_token: 'tok', token_type: 'Bearer' },
    });
    await expect(
      materializeHostStdioFiles({ server: parsed!, paths: local, token: 'tok' })
    ).rejects.toMatchObject({ code: 'plugin_data_unsafe' });
  });
});

describe('blocked plugin MCP servers', () => {
  it('maps blockMcpServers to policy-only blocked entries; Cowork accepts them', () => {
    expect(coworkBlockedMcpEntries([plugin])).toEqual([
      {
        name: 'fake_plugin',
        transport: 'policy-only',
        toolPolicy: { '*': 'blocked' },
      },
    ]);
    expect(() => assertCoworkHostPlugins([plugin])).not.toThrow();
    expect(
      coworkBlockedMcpEntries([{ ...plugin, blockMcpServers: [] }])
    ).toEqual([]);
  });

  it.each(['http', 'stdio'] as const)(
    'rejects case-folded blocked labels in the full %s declaration set',
    (transport) => {
      const declaredServers: MCPConfig[] = [
        { transport: 'http', serverUrl: 'https://e.test/eval' },
        { transport: 'stdio', command: '/bin/tool' },
      ];
      const blockedPlugin = { ...plugin, blockMcpServers: ['SERVER-2'] };
      const options = {
        servers: declaredServers
          .map((entry, index) => ({ ...entry, label: `server-${index + 1}` }))
          .filter((entry) => entry.transport === transport),
        declaredServers,
        plugins: [blockedPlugin],
      };
      expect(() => coworkManagedPluginSettings(options)).toThrow(
        expect.objectContaining({
          code: 'mcp_server_invalid',
          plugin: 'SERVER-2',
        })
      );
      expect(
        coworkMcpSettingsMatch(
          { allowManagedMcpServersOnly: true, managedMcpServers: [] },
          options
        )
      ).toBe(false);
      expect(() =>
        coworkManagedPluginSettings({
          servers: [{ ...declaredServers[1]!, label: 'Fake_Plugin' }],
          plugins: [plugin],
        })
      ).toThrow(
        expect.objectContaining({
          code: 'mcp_server_invalid',
          plugin: 'fake_plugin',
        })
      );
    }
  );

  it('rejects duplicate, invalid, or overridden-and-blocked names', () => {
    for (const bad of [
      { ...plugin, blockMcpServers: ['a', 'a'] },
      { ...plugin, blockMcpServers: ['bad name'] },
      {
        ...plugin,
        mcp: { fake_plugin: { url: 'https://e.test/eval' } },
      },
    ])
      expect(HostPluginsSchema.safeParse([bad]).success).toBe(false);
    expect(
      HostPluginsSchema.safeParse([plugin, { ...plugin, name: 'other' }])
        .success
    ).toBe(false);
  });
});
