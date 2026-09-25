import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCoworkMcpServers } from './mcpReadiness.js';
import {
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
    const { hostStdioReadinessConfig } = await import('../hostPlugins.js');
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

  it('refuses to launch an unresolved host-only stdio server directly', async () => {
    await expect(createMCPClientForConfig(server())).rejects.toThrow(
      'host-resolved eval fields'
    );
  });
});
