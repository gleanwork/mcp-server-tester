import { describe, expect, it } from 'vitest';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { chatgptServers } from './config.js';

const servers: MCPConfig[] = [
  {
    transport: 'http',
    label: 'glean',
    serverUrl: 'https://example.test/eval',
    auth: { accessToken: 'fixture-secret' },
  },
];

describe('ChatGPT server translation', () => {
  it('resolves HTTP auth only into launch environment and preserves stdio servers', () => {
    const mapped = chatgptServers(
      [
        {
          transport: 'http',
          label: 'http',
          serverUrl: 'https://example.test/eval',
          auth: { accessTokenEnv: 'TOKEN' },
        },
        {
          transport: 'stdio',
          label: 'stdio',
          command: 'node',
          args: ['fixture.mjs'],
        },
      ],
      { TOKEN: 'fixture-token' }
    );
    expect(mapped.environment).toEqual({
      MST_CHATGPT_MCP_TOKEN_0: 'fixture-token',
    });
    expect(JSON.stringify(mapped.servers)).not.toContain('fixture-token');
    expect(mapped.servers[1]).toMatchObject({
      label: 'stdio',
      command: 'node',
      args: ['fixture.mjs'],
    });
  });
  it.each([
    ['url', { url: 'https://example.test/eval', args: ['${url}'] }],
    ['a plugin root placeholder', { args: ['${pluginRoot:fake}/start.mjs'] }],
    ['a data dir placeholder', { env: { DATA: '${dataDir}' } }],
    ['files', { files: { 'a.json': {} } }],
    ['auth', { auth: { accessTokenEnv: 'TOKEN' } }],
    ['minTools', { minTools: 4 }],
  ])('rejects a host-resolved stdio eval server with %s', (_kind, change) => {
    expect(() =>
      chatgptServers(
        [{ transport: 'stdio', label: 'eval', command: 'node', ...change }],
        {}
      )
    ).toThrow('ChatGPT does not support host-resolved stdio eval servers');
  });
  it('rejects configured servers impersonating built-in host namespaces', () => {
    expect(() =>
      chatgptServers(
        [{ transport: 'stdio', label: 'cua_repl', command: 'node' }],
        {}
      )
    ).toThrow('reserved');
  });
  it('rejects missing credentials, duplicate labels and unsupported headers', () => {
    expect(() =>
      chatgptServers(
        servers.map((s) => ({
          ...s,
          auth: { accessTokenEnv: 'MISSING' },
        })),
        {}
      )
    ).toThrow('credential');
    expect(() => chatgptServers([...servers, ...servers], {})).toThrow(
      'unique'
    );
    expect(() =>
      chatgptServers(
        [
          {
            transport: 'http',
            serverUrl: 'https://example.test',
            headers: { 'x-secret': 'value' },
          },
        ],
        {}
      )
    ).toThrow('custom headers');
  });
});
