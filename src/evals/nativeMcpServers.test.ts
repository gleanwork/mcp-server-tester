import { afterEach, describe, expect, it } from 'vitest';
import { buildNativeMcpServers } from './nativeMcpServers.js';

const originalToken = process.env.TEST_NATIVE_MCP_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TEST_NATIVE_MCP_TOKEN;
  else process.env.TEST_NATIVE_MCP_TOKEN = originalToken;
});

describe('buildNativeMcpServers', () => {
  const definition = {
    name: 'example',
    url: 'https://example.test/mcp',
    tokenEnv: 'TEST_NATIVE_MCP_TOKEN',
    expectedMinTools: 1,
  };

  it('creates a proxy entry without putting the token in its arguments', async () => {
    process.env.TEST_NATIVE_MCP_TOKEN = 'secret-token';
    const entries = await buildNativeMcpServers([definition], ['example'], {
      preflight: false,
      proxyCommand: '/tmp/mcp-server-tester',
    });

    expect(entries.example).toEqual({
      command: '/tmp/mcp-server-tester',
      args: expect.arrayContaining([
        'proxy',
        '--upstream-url',
        'https://example.test/mcp',
        '--token-env',
        'TEST_NATIVE_MCP_TOKEN',
      ]),
      env: {},
    });
    expect(JSON.stringify(entries)).not.toContain('secret-token');
  });

  it('rejects non-HTTPS endpoints except loopback HTTP', async () => {
    process.env.TEST_NATIVE_MCP_TOKEN = 'secret-token';
    await expect(
      buildNativeMcpServers(
        [{ ...definition, url: 'http://vendor.example/mcp' }],
        ['example'],
        { preflight: false }
      )
    ).rejects.toThrow('must use https');

    await expect(
      buildNativeMcpServers(
        [{ ...definition, url: 'http://127.0.0.1:3000/mcp' }],
        ['example'],
        { preflight: false }
      )
    ).resolves.toHaveProperty('example');
  });
});
