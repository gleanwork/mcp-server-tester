import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCoworkMcpServers } from './mcpReadiness.js';
import {
  hostStdioReadinessConfig,
  hostStdioServers,
  materializeHostStdioFiles,
  type HostPlugin,
} from '../hostPlugins.js';
import { createMCPClientForConfig } from '../../mcp/clientFactory.js';
import type { MCPConfig } from '../../config/mcpConfig.js';

// A real stdio process: the fake plugin's adapter, launched from its root.
const pluginRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-plugin'
);
const plugin: HostPlugin = {
  name: 'fake',
  marketplace: { source: 'acme/plugins', ref: 'f'.repeat(40) },
  blockMcpServers: ['fake_plugin'],
};
const server = (url = 'https://example.test/mcp/default/eval') =>
  ({
    transport: 'stdio',
    label: 'fake-eval',
    command: process.execPath,
    args: ['${pluginRoot:fake}/mcp/start.mjs'],
    url,
    auth: { accessTokenEnv: 'FAKE_TOKEN' },
    minTools: 4,
    env: { FAKE_MCP_URL: '${url}', FAKE_PLUGIN_DATA: '${dataDir}' },
    files: {
      'creds.json': {
        tokens: { access_token: '${bearerToken}', token_type: 'Bearer' },
      },
    },
  }) as MCPConfig;
let dataRoot: string;
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'mst-ready-')));
  process.env.FAKE_PARENT_SECRET = 'parent-secret';
});
afterEach(async () => {
  delete process.env.FAKE_PARENT_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});
async function ready(token: string, url?: string) {
  const config = server(url);
  const paths = { pluginRoots: { fake: pluginRoot }, dataRoot };
  const [parsed] = hostStdioServers([config], [plugin]);
  await materializeHostStdioFiles({ server: parsed!, paths, token });
  return verifyCoworkMcpServers(
    [config],
    { FAKE_TOKEN: token },
    {
      plugins: [plugin],
      paths,
    }
  );
}

describe('Cowork stdio eval server readiness', () => {
  it('connects to the resolved launch and meets minTools', async () => {
    await expect(ready('good-token')).resolves.toMatchObject([
      { label: 'fake-eval', status: 'connected', toolCount: 4 },
    ]);
  }, 20_000);

  it('fails closed when a degraded adapter exposes fewer than minTools', async () => {
    // A bad credential or wrong endpoint leaves only static tools.
    for (const [token, url] of [
      ['bad-token', undefined],
      ['good-token', 'https://example.test/mcp/default'],
    ] as const) {
      await rm(join(dataRoot, 'fake-eval'), { recursive: true, force: true });
      await expect(ready(token, url)).rejects.toMatchObject({
        name: 'CoworkMcpReadinessError',
        servers: [
          {
            label: 'fake-eval',
            status: 'failed',
            toolCount: 1,
            error: 'too few tools (1 < 4)',
          },
        ],
      });
    }
  }, 20_000);

  it('never passes the parent environment to the stdio process', async () => {
    const paths = { pluginRoots: { fake: pluginRoot }, dataRoot };
    const [parsed] = hostStdioServers([server()], [plugin]);
    await materializeHostStdioFiles({
      server: parsed!,
      paths,
      token: 'good-token',
    });
    const client = await createMCPClientForConfig(
      hostStdioReadinessConfig(parsed!, paths)
    );
    try {
      const result = await client.callTool({
        name: 'leaked_env',
        arguments: {},
      });
      expect(result.content).toEqual([{ type: 'text', text: 'false' }]);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('connects plain stdio from a quoted cwd with no invented URL', async () => {
    const cwd = join(dataRoot, "cwd ' ; $(false)");
    await mkdir(cwd);
    await symlink(join(pluginRoot, 'mcp/start.mjs'), join(cwd, 'start.mjs'));
    const config: MCPConfig = {
      transport: 'stdio',
      command: process.execPath,
      args: ['./start.mjs', 'a; exit 1', '$(false)'],
      cwd,
      env: { DECLARED: 'only-this' },
    };
    await expect(verifyCoworkMcpServers([config], {})).resolves.toMatchObject([
      { label: 'server-1', status: 'connected', toolCount: 1 },
    ]);
  }, 20_000);

  it('keeps unnamed private paths aligned with the global server index', async () => {
    const configs: MCPConfig[] = [
      {
        transport: 'stdio',
        command: process.execPath,
        args: [join(pluginRoot, 'mcp/start.mjs')],
      },
      {
        transport: 'stdio',
        command: process.execPath,
        args: [join(pluginRoot, 'mcp/start.mjs')],
        env: {
          FAKE_MCP_URL: 'https://example.test/eval',
          FAKE_PLUGIN_DATA: '${dataDir}',
        },
        auth: { accessTokenEnv: 'FAKE_TOKEN' },
        minTools: 4,
        files: { 'creds.json': { tokens: { access_token: '${bearerToken}' } } },
      },
    ];
    const parsed = hostStdioServers(configs);
    await materializeHostStdioFiles({
      server: parsed[1]!,
      paths: { dataRoot },
      token: 'good-token',
    });
    const results = await verifyCoworkMcpServers(
      configs,
      { FAKE_TOKEN: 'good-token' },
      {
        paths: { dataRoot },
      }
    );
    expect(results).toMatchObject([
      { label: 'server-1', status: 'connected', toolCount: 1 },
      { label: 'server-2', status: 'connected', toolCount: 4 },
    ]);
    expect(JSON.stringify(results)).not.toContain('good-token');
    expect(JSON.stringify(results)).not.toContain(dataRoot);
  }, 20_000);

  it('reports sanitized failure metadata for an invalid plain launch', async () => {
    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'stdio',
            command: join(dataRoot, 'secret-command'),
            env: { PRIVATE_VALUE: 'metadata-secret' },
          },
        ],
        {}
      )
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('secret-command');
      expect(serialized).not.toContain('metadata-secret');
      expect(serialized).not.toContain(dataRoot);
      return (
        (error as { servers: Array<{ status: string }> }).servers[0]?.status ===
        'failed'
      );
    });
  });

  it('refuses to launch an unresolved host-only stdio server directly', async () => {
    await expect(createMCPClientForConfig(server())).rejects.toThrow(
      'host-resolved eval fields'
    );
  });
});
