import { describe, expect, it } from 'vitest';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { chatgptServers } from './config.js';
import { renderCodexConfig } from '../codexSetup/config.js';

const servers: MCPConfig[] = [
  {
    transport: 'http',
    label: 'acme',
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
  ])('rejects a client-resolved stdio eval server with %s', (_kind, change) => {
    expect(() =>
      chatgptServers(
        [{ transport: 'stdio', label: 'eval', command: 'node', ...change }],
        {}
      )
    ).toThrow('ChatGPT does not support client-resolved stdio eval servers');
  });
  it("keeps a plain stdio server's minTools for the preflight, as for a dry-run proxy", () => {
    const mapped = chatgptServers(
      [
        {
          transport: 'stdio',
          label: 'slack',
          command: 'node',
          args: ['proxy.js', '--token-file', '/private/slack.json'],
          minTools: 4,
        },
      ],
      {}
    );
    expect(mapped.servers[0]).toMatchObject({ label: 'slack', minTools: 4 });
    // MST's readiness rule only: never written for the app.
    expect(renderCodexConfig(mapped.servers)).not.toContain('minTools');
  });
  it.each(['cua_repl', 'codex'])(
    'rejects configured servers impersonating built-in namespace %s',
    (label) => {
      expect(() =>
        chatgptServers([{ transport: 'stdio', label, command: 'node' }], {})
      ).toThrow('reserved');
    }
  );
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
