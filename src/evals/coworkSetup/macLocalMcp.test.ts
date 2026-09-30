import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../../mcp/clientFactory.js';
import type { MCPConfig, StdioMCPConfig } from '../../config/mcpConfig.js';
import {
  installMacLocalMcp,
  preflightMacLocalMcp,
  restoreMacLocalMcp,
} from './macLocalMcp.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: vi.fn(),
  tmpdir: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');
let root: string, directory: string, config: string;
const original = Buffer.from(
  ' { "preferences": {"theme":"dark"}, "mcpServers": {"existing":{"command":"existing"}} }\n'
);
const remote: MCPConfig = {
  transport: 'http',
  label: 'glean-eval',
  serverUrl: 'https://example.test/mcp',
  auth: { accessTokenEnv: 'TEST_TOKEN' },
};
const env = { TEST_TOKEN: 'synthetic-credential' };
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-local-test-'))
  );
  vi.mocked(os.homedir).mockReturnValue(root);
  vi.mocked(os.tmpdir).mockReturnValue(root);
  directory = join(root, `mst-cowork-session-${randomUUID()}-mcp`);
  config = join(
    root,
    'Library/Application Support/Claude-3p/claude_desktop_config.json'
  );
  await fs.mkdir(join(root, 'Library/Application Support/Claude-3p'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(config, original, { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function entry(label = 'glean-eval'): Promise<StdioMCPConfig> {
  const value = JSON.parse(await fs.readFile(config, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  return { transport: 'stdio', ...value.mcpServers[label]!, quiet: true };
}
describe('Mac local MCP transaction', () => {
  it('keeps credentials out of app settings and restores exact bytes after Claude reformats JSON', async () => {
    await installMacLocalMcp(directory, [remote], env);
    const installed = await fs.readFile(config, 'utf8');
    expect(installed).not.toContain(env.TEST_TOKEN);
    expect(installed).not.toContain('existing');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(join(directory, 'glean-eval.json'))).mode & 0o777
    ).toBe(0o600);
    await fs.writeFile(config, JSON.stringify(JSON.parse(installed)));
    await restoreMacLocalMcp(directory);
    expect(await fs.readFile(config)).toEqual(original);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreMacLocalMcp(directory);
  });
  it('retains recovery state rather than clobbering a semantic user change', async () => {
    await installMacLocalMcp(directory, [remote], env);
    const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<
      string,
      unknown
    >;
    data.preferences = { theme: 'light' };
    await fs.writeFile(config, JSON.stringify(data));
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
    expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
      true
    );
    expect(await fs.readFile(config, 'utf8')).toContain('light');
  });
  it('restores a previously absent developer file to absent', async () => {
    await fs.unlink(config);
    await installMacLocalMcp(directory, [], {});
    await restoreMacLocalMcp(directory);
    await expect(fs.stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails before writes for missing credentials, duplicate names, reserved labels and host-resolved launches', async () => {
    await expect(preflightMacLocalMcp([remote], {})).rejects.toThrow();
    for (const servers of [
      [remote, remote],
      [{ ...remote, label: 'journal' }],
      [
        {
          transport: 'stdio',
          label: 'proxy',
          command: 'node',
          args: ['${pluginRoot:x}'],
        },
      ],
    ] as MCPConfig[][])
      await expect(preflightMacLocalMcp(servers, env)).rejects.toThrow();
    expect(await fs.readFile(config)).toEqual(original);
  });
  it('refuses a symlinked developer config', async () => {
    const other = join(root, 'other');
    await fs.rename(config, other);
    await fs.symlink(other, config);
    await expect(
      installMacLocalMcp(directory, [remote], env)
    ).rejects.toThrow();
    expect(await fs.readFile(other)).toEqual(original);
  });
  it('actually bridges HTTP initialize, tools/list and tools/call through local stdio', async () => {
    const upstream = new Server(
      { name: 'synthetic-upstream', version: '1' },
      { capabilities: { tools: {} } }
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'test_read', inputSchema: { type: 'object' } }],
    }));
    upstream.setRequestHandler('tools/call', async () => ({
      content: [{ type: 'text', text: 'read succeeded' }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await upstream.connect(transport);
    let authenticated = 0;
    const http = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${env.TEST_TOKEN}`) {
          response.writeHead(401).end();
          return;
        }
        authenticated++;
        // This fixture only needs request/response, not an unsolicited SSE stream.
        if (request.method === 'GET') {
          response.writeHead(405).end();
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk))
            throw new Error('Expected request bytes');
          chunks.push(chunk);
        }
        const result = await transport.handleRequest(
          new Request('http://127.0.0.1/mcp', {
            method: request.method,
            headers,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          })
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    let client:
      | Awaited<ReturnType<typeof createMCPClientForConfig>>
      | undefined;
    try {
      await installMacLocalMcp(
        directory,
        [{ ...remote, serverUrl: `http://127.0.0.1:${address.port}/mcp` }],
        env
      );
      client = await createMCPClientForConfig({
        ...(await entry()),
        connectTimeoutMs: 5000,
      });
      expect((await client.listTools()).tools[0]?.name).toBe('test_read');
      expect(
        await client.callTool({ name: 'test_read', arguments: {} })
      ).toMatchObject({ content: [{ text: 'read succeeded' }] });
      expect(authenticated).toBeGreaterThan(2);
    } finally {
      if (client) await closeMCPClient(client);
      await upstream.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await restoreMacLocalMcp(directory);
    }
  }, 15000);
  it('launches a declared stdio proxy with explicit credentials, without putting them in app settings', async () => {
    const fixture = join(root, 'fixture.cjs');
    await fs.writeFile(
      fixture,
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:process.env.TEST_TOKEN==='synthetic-credential'?'token_received':'token_missing',inputSchema:{type:'object'}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`
    );
    await installMacLocalMcp(
      directory,
      [
        {
          transport: 'stdio',
          label: 'slack',
          command: process.execPath,
          args: [fixture],
        },
      ],
      env
    );
    const client = await createMCPClientForConfig(await entry('slack'));
    try {
      expect((await client.listTools()).tools[0]?.name).toBe('token_received');
      expect(await fs.readFile(config, 'utf8')).not.toContain(env.TEST_TOKEN);
    } finally {
      await closeMCPClient(client);
      await restoreMacLocalMcp(directory);
    }
  });
});
