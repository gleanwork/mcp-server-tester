import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
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

import { installMacToolPermissions } from './macToolPermissionStore.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));
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
  label: 'acme-eval',
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
async function entry(label = 'acme-eval'): Promise<StdioMCPConfig> {
  const value = JSON.parse(await fs.readFile(config, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  return { transport: 'stdio', ...value.mcpServers[label]!, quiet: true };
}
describe('Mac local MCP transaction', () => {
  it('keeps credentials out of app settings and restores exact bytes after Claude reformats JSON', async () => {
    await fs.chmod(config, 0o644);
    await installMacLocalMcp(directory, [remote], env);
    const installed = await fs.readFile(config, 'utf8');
    expect(installed).not.toContain(env.TEST_TOKEN);
    expect(installed).not.toContain('existing');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(join(directory, 'acme-eval.json'))).mode & 0o777
    ).toBe(0o600);
    await fs.writeFile(config, JSON.stringify(JSON.parse(installed)));
    await restoreMacLocalMcp(directory);
    expect(await fs.readFile(config)).toEqual(original);
    expect((await fs.stat(config)).mode & 0o777).toBe(0o644);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreMacLocalMcp(directory);
  });
  it('preserves unrelated preference changes while restoring only mcpServers', async () => {
    await installMacLocalMcp(directory, [remote], env);
    const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<
      string,
      unknown
    >;
    data.preferences = { theme: 'light', epitaxyPrefs: { enabled: true } };
    data.newPreference = [1, 2];
    await fs.writeFile(config, JSON.stringify(data));
    await restoreMacLocalMcp(directory);
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({
      preferences: { theme: 'light', epitaxyPrefs: { enabled: true } },
      newPreference: [1, 2],
      mcpServers: { existing: { command: 'existing' } },
    });
    await restoreMacLocalMcp(directory);
  });
  it.each(['added', 'edited', 'removed', 'null'])(
    'retains recovery state for %s MCP entries',
    async (kind) => {
      await installMacLocalMcp(directory, [remote], env);
      const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<
        string,
        unknown
      >;
      const servers = data.mcpServers as Record<string, unknown>;
      if (kind === 'added') servers.newServer = { command: 'user' };
      else if (kind === 'edited') servers['acme-eval'] = { command: 'user' };
      else if (kind === 'removed') delete data.mcpServers;
      else data.mcpServers = null;
      await fs.writeFile(config, JSON.stringify(data));
      const before = await fs.readFile(config);
      const receipt = await fs.readFile(join(directory, 'journal.json'));
      await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
      expect(await fs.readFile(config)).toEqual(before);
      expect(await fs.readFile(join(directory, 'journal.json'))).toEqual(
        receipt
      );
    }
  );
  it.each([false, true])(
    'keeps legacy journals strict (unrelated edit: %s)',
    async (changed) => {
      await installMacLocalMcp(directory, [remote], env);
      const receipt = join(directory, 'journal.json');
      const journal = JSON.parse(await fs.readFile(receipt, 'utf8')) as Record<
        string,
        unknown
      >;
      delete journal.installedMcpServersHash;
      await fs.writeFile(receipt, JSON.stringify(journal));
      const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<
        string,
        unknown
      >;
      if (changed) data.preferences = { theme: 'light' };
      await fs.writeFile(config, JSON.stringify(data));
      const before = await fs.readFile(config);
      if (changed) {
        await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
        expect(await fs.readFile(config)).toEqual(before);
        expect((await fs.stat(receipt)).isFile()).toBe(true);
      } else {
        await restoreMacLocalMcp(directory);
        expect(await fs.readFile(config)).toEqual(original);
      }
    }
  );
  it.each(['missing file', 'missing map'])(
    'preserves new preferences with an originally %s',
    async (kind) => {
      if (kind === 'missing file') await fs.unlink(config);
      else await fs.writeFile(config, '{"preferences":{"theme":"dark"}}');
      await installMacLocalMcp(directory, [], {});
      await fs.writeFile(
        config,
        '{"preferences":{"epitaxyPrefs":true},"mcpServers":{}}'
      );
      await restoreMacLocalMcp(directory);
      expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({
        preferences: { epitaxyPrefs: true },
      });
    }
  );
  it.each(['owned edit', 'preference edit', 'same-byte replacement'])(
    'refuses a %s race during restore staging',
    async (kind) => {
      await installMacLocalMcp(directory, [remote], env);
      let changed: Buffer | undefined;
      const writeFile = fs.writeFile;
      vi.spyOn(fs, 'writeFile').mockImplementation(
        async (path, data, options) => {
          await writeFile(path, data, options);
          if (typeof path === 'string' && path.includes('config.restore-')) {
            const value = JSON.parse(
              await fs.readFile(config, 'utf8')
            ) as Record<string, unknown>;
            if (kind === 'owned edit')
              value.mcpServers = { user: { command: 'user' } };
            else if (kind === 'preference edit')
              value.preferences = { theme: 'concurrent' };
            changed =
              kind === 'same-byte replacement'
                ? await fs.readFile(config)
                : Buffer.from(JSON.stringify(value));
            if (kind === 'same-byte replacement') {
              const replacement = join(root, 'replacement');
              await writeFile(replacement, changed, { mode: 0o600 });
              await fs.rename(replacement, config);
            } else await writeFile(config, changed);
          }
        }
      );
      await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
      expect(changed).toBeDefined();
      expect(await fs.readFile(config)).toEqual(changed);
      expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
        true
      );
      expect(
        (await fs.readdir(directory)).some((name) =>
          name.startsWith('config.restore-')
        )
      ).toBe(false);
    }
  );
  it('retains the journal if config changes after replacement', async () => {
    await installMacLocalMcp(directory, [remote], env);
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === config)
        await fs.writeFile(config, '{"mcpServers":{"user":{}}}');
    });
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
    expect(await fs.readFile(config, 'utf8')).toBe(
      '{"mcpServers":{"user":{}}}'
    );
    expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
      true
    );
  });
  it('retries interrupted recovery and still restores tool permissions', async () => {
    await fs.chmod(config, 0o644);
    await installMacLocalMcp(directory, [remote], env);
    const permissionConfig = join(
      root,
      'Library/Application Support/Claude-3p/local-agent-mode-sessions/1234abcd/87654321/cowork_account_settings.json'
    );
    await fs.mkdir(dirname(permissionConfig), { recursive: true, mode: 0o700 });
    const permissions =
      ' {"enabled_mcp_tools":{"local:acme-eval:search":false}}\n';
    await fs.writeFile(permissionConfig, permissions, { mode: 0o644 });
    await installMacToolPermissions(directory, {
      'local:acme-eval:search': true,
    });
    const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<
      string,
      unknown
    >;
    data.preferences = { epitaxyPrefs: true };
    await fs.writeFile(config, JSON.stringify(data));
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === permissionConfig) throw new Error('synthetic interruption');
      await rename(from, to);
    });
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
    const restored = await fs.readFile(config);
    expect(JSON.parse(restored.toString())).toEqual({
      preferences: { epitaxyPrefs: true },
      mcpServers: { existing: { command: 'existing' } },
    });
    expect((await fs.stat(config)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(join(directory, 'permissions.json'))).isFile()).toBe(
      true
    );
    vi.restoreAllMocks();
    await restoreMacLocalMcp(directory);
    expect(await fs.readFile(config)).toEqual(restored);
    expect(await fs.readFile(permissionConfig, 'utf8')).toBe(permissions);
    expect((await fs.stat(permissionConfig)).mode & 0o777).toBe(0o644);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreMacLocalMcp(directory);
  });
  it('retries a failure before config replacement without leaving a staging collision', async () => {
    await installMacLocalMcp(directory, [remote], env);
    const before = await fs.readFile(config);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('synthetic interruption')
    );
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow(
      'synthetic interruption'
    );
    expect(await fs.readFile(config)).toEqual(before);
    expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
      true
    );
    await restoreMacLocalMcp(directory);
    expect(await fs.readFile(config)).toEqual(original);
  });
  it.each([
    'config',
    'journal',
    'library',
    'app support',
    'app directory',
    'session',
  ])('refuses a symlinked %s during recovery', async (kind) => {
    await installMacLocalMcp(directory, [remote], env);
    const before = await fs.readFile(config);
    const path =
      kind === 'config'
        ? config
        : kind === 'journal'
          ? join(directory, 'journal.json')
          : kind === 'library'
            ? join(root, 'Library')
            : kind === 'app support'
              ? join(root, 'Library/Application Support')
              : kind === 'app directory'
                ? dirname(config)
                : directory;
    await fs.rename(path, path + '.original');
    await fs.symlink(path + '.original', path);
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow();
    expect(await fs.readFile(config)).toEqual(before);
    expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
      true
    );
  });
  it.each([
    'config mode',
    'journal mode',
    'parent mode',
    'ownership',
    'hardlink',
  ])('refuses unsafe %s during recovery', async (kind) => {
    await installMacLocalMcp(directory, [remote], env);
    const before = await fs.readFile(config);
    if (kind === 'config mode') await fs.chmod(config, 0o666);
    else if (kind === 'journal mode')
      await fs.chmod(join(directory, 'journal.json'), 0o644);
    else if (kind === 'parent mode') await fs.chmod(dirname(config), 0o777);
    else if (kind === 'ownership')
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    else await fs.link(config, join(root, 'linked-config'));
    await expect(restoreMacLocalMcp(directory)).rejects.toThrow('safely');
    expect(await fs.readFile(config)).toEqual(before);
    expect((await fs.stat(join(directory, 'journal.json'))).isFile()).toBe(
      true
    );
  });
  it('restores a previously absent developer file to absent', async () => {
    await fs.unlink(config);
    await installMacLocalMcp(directory, [], {});
    await restoreMacLocalMcp(directory);
    await expect(fs.stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails before writes for missing credentials, duplicate names, reserved labels and client-resolved launches', async () => {
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
  it.each(['permissions', 'Permissions', 'PERMISSIONS'])(
    'rejects the permission journal filename collision before installing %s',
    async (label) => {
      await expect(
        installMacLocalMcp(directory, [{ ...remote, label }], env)
      ).rejects.toThrow();
      expect(await fs.readFile(config)).toEqual(original);
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );
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
      { capabilities: { tools: { listChanged: true } } }
    );
    let inventoryRequests = 0;
    let inventoryChanged = false;
    upstream.setRequestHandler('tools/list', async () => {
      inventoryRequests++;
      return {
        tools: [
          {
            name: inventoryChanged ? 'test_updated' : 'test_read',
            description: 'x'.repeat(76000),
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          ...Array.from({ length: 41 }, (_, index) => ({
            name: `test_tool_${index}`,
            inputSchema: { type: 'object' as const },
          })),
        ],
        ttlMs: 60000,
        cacheScope: 'private',
        _meta: { fixture: 'preserved' },
      };
    });
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
        if (result.body) {
          const reader = result.body.getReader();
          response.on('close', () => void reader.cancel());
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(Buffer.from(chunk.value));
          }
        }
        response.end();
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
      expect(inventoryRequests).toBe(1);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(42);
      expect(listed.tools[0]).toMatchObject({
        name: 'test_read',
        annotations: { readOnlyHint: true },
      });
      expect(listed._meta).toEqual({ fixture: 'preserved' });
      expect(listed).not.toHaveProperty('ttlMs');
      expect(listed).not.toHaveProperty('cacheScope');
      expect(inventoryRequests).toBe(1);
      expect(
        await client.callTool({ name: 'test_read', arguments: {} })
      ).toMatchObject({ content: [{ text: 'read succeeded' }] });
      expect(authenticated).toBeGreaterThan(2);
      inventoryChanged = true;
      await upstream.notification({
        method: 'notifications/tools/list_changed',
      });
      await expect.poll(() => inventoryRequests).toBe(2);
      await expect
        .poll(async () => (await client!.listTools()).tools[0]?.name)
        .toBe('test_updated');
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
