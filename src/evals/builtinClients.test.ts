import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinClientConfig, getClient } from './builtinClients.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The servers Claude Code is given, from its --mcp-config argument. */
function claudeMcpConfig(args: readonly string[]): unknown {
  return JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
}

describe('getBuiltinClientConfig', () => {
  it('passes the configured model to the Claude CLI', () => {
    const config = getBuiltinClientConfig(
      'claude-code',
      { model: 'claude-sonnet-4-6' },
      [{ transport: 'http', serverUrl: 'https://example.com/mcp' }]
    );

    expect(config.cli?.args).toContain('--model');
    expect(config.cli?.args).toContain('claude-sonnet-4-6');
  });

  it("gives Claude Code exactly the eval's servers", () => {
    const config = getBuiltinClientConfig('claude-code', {}, [
      {
        transport: 'http',
        label: 'docs',
        serverUrl: 'https://example.com/mcp',
        auth: { accessToken: 'token' },
      },
      { transport: 'stdio', label: 'local', command: 'node', args: ['s.js'] },
    ]);
    const mcpServers = {
      docs: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
      local: { command: 'node', args: ['s.js'] },
    };
    expect(claudeMcpConfig(config.cli!.args)).toEqual({ mcpServers });
    expect(config.mcpServers).toEqual(mcpServers);
    expect(config.cli?.claudeMcpServers).toEqual(['docs', 'local']);
    expect(config.cli?.args).toContain('--strict-mcp-config');
  });

  it('adds no server from the environment, and writes no plugin file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-claude-env-'));
    try {
      // The variables Claude Code's removed plugin settings fell back to.
      vi.stubEnv('MCP_SERVER_URL', 'https://ambient.invalid/mcp');
      vi.stubEnv('MCP_ACCESS_TOKEN', 'ambient-token');
      vi.stubEnv('MCP_PLUGIN_DIR', path.join(home, 'plugin'));
      vi.stubEnv('MCP_PLUGIN_DATA_DIR', home);
      vi.stubEnv('MCP_PLUGIN_SERVER_URL', 'https://plugin.invalid/mcp');
      const config = getBuiltinClientConfig('claude-code', {});
      expect(claudeMcpConfig(config.cli!.args)).toEqual({ mcpServers: {} });
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('client options that never had an effect', () => {
  const servers = [{ transport: 'http', serverUrl: 'https://example.com/mcp' }];
  it.each([
    ['api', 'server', servers[0]],
    ['api', 'servers', servers],
    ['claude-code', 'server', servers[0]],
    ['claude-code', 'servers', servers],
    ['claude-code', 'apiToken', 'token'],
    ['claude-code', 'pluginDir', './plugin'],
    ['claude-code', 'pluginMcpUrl', 'https://example.com/mcp'],
  ])('%s rejects %s', (client, key, value) => {
    const parsed = getClient(client).schema.safeParse({
      type: client,
      [key]: value,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(
      new RegExp(`^\`clientOptions\\.${key}\` is gone: remove it\\. `)
    );
  });
});
