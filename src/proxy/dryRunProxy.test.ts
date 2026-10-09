import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import {
  PLANNED_WRITE_KEY,
  createDryRunProxy,
  fileToken,
  isReadOnlyTool,
  staticToken,
  type DryRunProxy,
  type DryRunProxyOptions,
} from './dryRunProxy.js';
import { parseDryRunProxyArgs } from './dryRunProxyArgs.js';
import type { SimulatedWriteRecord } from './simulatedWrites.js';

const TOOLS = [
  {
    name: 'search',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_message',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: false },
  },
  // Annotated read-only but destructive: a write.
  {
    name: 'purge',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
  // No annotations: a write unless allowlisted.
  { name: 'get_profile', inputSchema: { type: 'object' as const } },
  // Annotated read-only, but the connector knows it writes.
  {
    name: 'mark_read',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true },
  },
  // A write that declares what it returns.
  {
    name: 'create_issue',
    inputSchema: { type: 'object' as const },
    outputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        number: { type: 'integer' },
      },
      required: ['id', 'url'],
    },
    annotations: { readOnlyHint: false },
  },
];

/** A fake vendor MCP server behind bearer auth, reachable through `fetch`. */
function fakeVendor(options: { tools?: typeof TOOLS } = {}) {
  const calls: string[] = [];
  const tokens: string[] = [];
  let validToken = 'token-1';
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  function newServer() {
    const server = new Server(
      { name: 'vendor', version: '1' },
      { capabilities: { tools: { listChanged: true } } }
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: options.tools ?? TOOLS,
    }));
    server.setRequestHandler('tools/call', async (request) => {
      calls.push(request.params.name);
      return {
        content: [{ type: 'text', text: `ran ${request.params.name}` }],
      };
    });
    return server;
  }

  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const auth = request.headers.get('authorization') ?? '';
    tokens.push(auth);
    if (auth !== `Bearer ${validToken}`)
      return new Response('unauthorized', { status: 401 });
    const id = request.headers.get('mcp-session-id');
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, transport!);
        },
      });
      await newServer().connect(transport);
    }
    return transport.handleRequest(request);
  };

  return {
    fetch: fetchFn,
    calls,
    tokens,
    rotate(next: string) {
      validToken = next;
    },
  };
}

async function connect(
  options: Omit<DryRunProxyOptions, 'upstreamUrl' | 'name'> & {
    vendor: ReturnType<typeof fakeVendor>;
  }
): Promise<{ client: Client; proxy: DryRunProxy; logs: string[] }> {
  const logs: string[] = [];
  const { vendor, ...rest } = options;
  const proxy = await createDryRunProxy({
    upstreamUrl: 'https://vendor.example/mcp',
    name: 'vendor',
    fetch: vendor.fetch,
    log: (line) => logs.push(line),
    ...rest,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return { client, proxy, logs };
}

describe('dry-run proxy', () => {
  let open: Array<{ client: Client; proxy: DryRunProxy }> = [];
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-proxy-'));
  });
  afterEach(async () => {
    for (const { client, proxy } of open) {
      await client.close();
      await proxy.close();
    }
    open = [];
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function start(
    options: Parameters<typeof connect>[0]
  ): ReturnType<typeof connect> {
    const connected = await connect(options);
    open.push(connected);
    return connected;
  }

  it('lists the upstream tools unchanged', async () => {
    const vendor = fakeVendor();
    const { client } = await start({ vendor, token: staticToken('token-1') });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      TOOLS.map((tool) => tool.name)
    );
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
  });

  it('forwards read-only calls and intercepts writes', async () => {
    const vendor = fakeVendor();
    const { client } = await start({ vendor, token: staticToken('token-1') });
    await client.listTools();

    const read = await client.callTool({
      name: 'search',
      arguments: { q: 'x' },
    });
    expect(read.content).toEqual([{ type: 'text', text: 'ran search' }]);

    const write = await client.callTool({
      name: 'send_message',
      arguments: { channel: 'C1', text: 'hi' },
    });
    expect(write.structuredContent).toEqual({
      [PLANNED_WRITE_KEY]: {
        server: 'vendor',
        tool_name: 'send_message',
        arguments: { channel: 'C1', text: 'hi' },
      },
    });
    expect(write.isError).toBeUndefined();

    for (const name of ['purge', 'get_profile'])
      expect(
        (await client.callTool({ name, arguments: {} })).structuredContent
      ).toHaveProperty(PLANNED_WRITE_KEY);

    expect(vendor.calls).toEqual(['search']);
  });

  it('applies the read-only and always-write lists', async () => {
    const vendor = fakeVendor();
    const { client } = await start({
      vendor,
      token: staticToken('token-1'),
      readOnlyTools: ['get_profile'],
      alwaysWriteTools: ['mark_read'],
    });
    await client.listTools();
    await client.callTool({ name: 'get_profile', arguments: {} });
    const marked = await client.callTool({ name: 'mark_read', arguments: {} });
    expect(marked.structuredContent).toHaveProperty(PLANNED_WRITE_KEY);
    expect(vendor.calls).toEqual(['get_profile']);
  });

  it('looks up a tool the client called before listing tools', async () => {
    const vendor = fakeVendor();
    const { client } = await start({ vendor, token: staticToken('token-1') });
    await client.callTool({ name: 'search', arguments: {} });
    const write = await client.callTool({
      name: 'send_message',
      arguments: {},
    });
    expect(write.structuredContent).toHaveProperty(PLANNED_WRITE_KEY);
    expect(vendor.calls).toEqual(['search']);
  });

  it('treats a tool the server does not list as a write', async () => {
    const vendor = fakeVendor();
    const { client } = await start({ vendor, token: staticToken('token-1') });
    const result = await client.callTool({
      name: 'hidden_tool',
      arguments: {},
    });
    expect(result.structuredContent).toHaveProperty(PLANNED_WRITE_KEY);
    expect(vendor.calls).toEqual([]);
  });

  it('adds planned-write aliases for graders that read an older key', async () => {
    const vendor = fakeVendor();
    const { client } = await start({
      vendor,
      token: staticToken('token-1'),
      plannedWriteAliases: ['_legacy_planned_write'],
    });
    const result = await client.callTool({
      name: 'send_message',
      arguments: {},
    });
    expect(result.structuredContent).toHaveProperty(PLANNED_WRITE_KEY);
    expect(result.structuredContent).toHaveProperty('_legacy_planned_write');
  });

  it('simulates writes: a success reply, recorded, never forwarded', async () => {
    const vendor = fakeVendor();
    const file = join(dir, 'vendor.jsonl');
    const { client } = await start({
      vendor,
      token: staticToken('token-1'),
      simulateWrites: {
        file,
        replies: {
          send_message: {
            ok: true,
            channel: '{{arguments.channel}}',
            ts: '{{unixTime}}',
            message: { text: '{{arguments.text}}' },
          },
        },
      },
    });
    await client.listTools();

    // A template from the connector.
    const sent = await client.callTool({
      name: 'send_message',
      arguments: { channel: 'C1', text: 'hi' },
    });
    const reply = JSON.parse(
      (sent.content as Array<{ text: string }>)[0]!.text
    );
    expect(reply).toMatchObject({
      ok: true,
      channel: 'C1',
      message: { text: 'hi' },
    });
    expect(reply.ts).toMatch(/^\d+\.\d{6}$/);
    expect(JSON.stringify(sent)).not.toContain(PLANNED_WRITE_KEY);
    expect(sent.isError).toBeUndefined();

    // No template: the tool's outputSchema, as structured content.
    const created = await client.callTool({
      name: 'create_issue',
      arguments: { title: 'Bug' },
    });
    const issue = created.structuredContent as Record<string, unknown>;
    expect(Object.keys(issue).sort()).toEqual(['id', 'url']);
    expect(issue.url).toBe(`https://example.com/${String(issue.id)}`);

    // Neither: a generic success that echoes what was written.
    const purged = await client.callTool({
      name: 'purge',
      arguments: { all: true },
    });
    expect(
      JSON.parse((purged.content as Array<{ text: string }>)[0]!.text)
    ).toMatchObject({ ok: true, result: { all: true } });

    expect(vendor.calls).toEqual([]);
    const records = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SimulatedWriteRecord);
    expect(records.map((r) => [r.server, r.tool, r.arguments])).toEqual([
      ['vendor', 'send_message', { channel: 'C1', text: 'hi' }],
      ['vendor', 'create_issue', { title: 'Bug' }],
      ['vendor', 'purge', { all: true }],
    ]);
    expect(records[0]!.reply).toBe(
      (sent.content as Array<{ text: string }>)[0]!.text
    );
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('answers a write it cannot record as planned, still without forwarding it', async () => {
    const vendor = fakeVendor();
    const { client, logs } = await start({
      vendor,
      token: staticToken('token-1'),
      simulateWrites: { file: join(dir, 'missing', 'vendor.jsonl') },
    });
    const write = await client.callTool({
      name: 'send_message',
      arguments: { text: 'hi' },
    });
    expect(write.structuredContent).toHaveProperty(PLANNED_WRITE_KEY);
    expect(vendor.calls).toEqual([]);
    expect(logs.join('\n')).toContain(
      "Couldn't record a simulated write of send_message"
    );
  });

  it('reads a renewed token from the file without restarting the session', async () => {
    const vendor = fakeVendor();
    const file = join(dir, 'token.json');
    const write = async (token: string) => {
      const temporary = `${file}.${randomUUID()}`;
      await fs.writeFile(
        temporary,
        JSON.stringify({ version: 1, accessToken: token }),
        { mode: 0o600 }
      );
      await fs.rename(temporary, file);
    };
    await write('token-1');
    const { client } = await start({ vendor, token: fileToken(file) });
    await client.callTool({ name: 'search', arguments: {} });

    vendor.rotate('token-2');
    await write('token-2');
    await client.callTool({ name: 'search', arguments: {} });

    expect(vendor.calls).toEqual(['search', 'search']);
    expect(vendor.tokens.at(-1)).toBe('Bearer token-2');
  });

  it('after a 401, waits for a new token and retries once', async () => {
    const vendor = fakeVendor();
    const file = join(dir, 'token.json');
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, accessToken: 'token-1' }),
      { mode: 0o600 }
    );
    const { client, logs } = await start({
      vendor,
      token: fileToken(file, 20),
      authRetryWaitMs: 5_000,
    });
    await client.listTools();
    // The server revokes the token early; MST delivers a new one shortly after.
    vendor.rotate('token-2');
    setTimeout(() => {
      void fs
        .writeFile(
          `${file}.next`,
          JSON.stringify({ version: 1, accessToken: 'token-2' })
        )
        .then(() => fs.rename(`${file}.next`, file));
    }, 100);
    const result = await client.callTool({ name: 'search', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'ran search' }]);
    expect(logs.join('\n')).toContain('retrying once with a new one');
    expect(logs.join('\n')).not.toContain('token-');
  });

  it('reports an expired token without leaking it', async () => {
    const vendor = fakeVendor();
    const { client, logs } = await start({
      vendor,
      token: staticToken('token-1'),
      authRetryWaitMs: 10,
    });
    await client.listTools();
    vendor.rotate('token-2');
    await expect(
      client.callTool({ name: 'search', arguments: {} })
    ).rejects.toThrow();
    expect(logs.join('\n')).toContain('CONNECTOR_AUTH_EXPIRED');
    expect(logs.join('\n')).not.toContain('token-1');
  });

  it('fails to start when the upstream rejects the token', async () => {
    const vendor = fakeVendor();
    await expect(
      createDryRunProxy({
        upstreamUrl: 'https://vendor.example/mcp',
        name: 'vendor',
        fetch: vendor.fetch,
        token: staticToken('wrong'),
        authRetryWaitMs: 10,
        log: () => {},
      })
    ).rejects.toThrow();
  });
});

describe('isReadOnlyTool', () => {
  it('needs readOnlyHint true and not destructiveHint true', () => {
    const tool = (annotations?: Record<string, boolean>) => ({
      name: 't',
      inputSchema: { type: 'object' as const },
      ...(annotations ? { annotations } : {}),
    });
    expect(isReadOnlyTool(tool({ readOnlyHint: true }))).toBe(true);
    expect(
      isReadOnlyTool(tool({ readOnlyHint: true, destructiveHint: false }))
    ).toBe(true);
    expect(
      isReadOnlyTool(tool({ readOnlyHint: true, destructiveHint: true }))
    ).toBe(false);
    expect(isReadOnlyTool(tool({ readOnlyHint: false }))).toBe(false);
    expect(isReadOnlyTool(tool())).toBe(false);
    expect(isReadOnlyTool(undefined)).toBe(false);
  });
});

describe('fileToken', () => {
  it('rejects a malformed or missing file', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-token-'));
    try {
      const file = join(dir, 'token.json');
      expect(() => fileToken(file)).toThrow('Cannot read the token file.');
      await fs.writeFile(file, JSON.stringify({ accessToken: 'x' }));
      expect(() => fileToken(file)).toThrow('malformed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseDryRunProxyArgs', () => {
  it('parses lists and headers', () => {
    const parsed = parseDryRunProxyArgs(
      [
        '--upstream-url',
        'https://mcp.example/mcp',
        '--name',
        'slack',
        '--token-env',
        'SLACK',
        '--header',
        'X-Api: v2',
        '--read-only',
        'a',
        '--read-only',
        'b',
        '--always-write',
        'c',
      ],
      { SLACK: 'secret' }
    );
    expect(parsed).toMatchObject({
      upstreamUrl: 'https://mcp.example/mcp',
      name: 'slack',
      headers: { 'X-Api': 'v2' },
      readOnlyTools: ['a', 'b'],
      alwaysWriteTools: ['c'],
    });
    expect(parsed.token?.current()).toBe('secret');
  });

  it('parses simulated writes and their reply templates', () => {
    const base = [
      '--upstream-url',
      'https://mcp.example/mcp',
      '--name',
      'slack',
    ];
    expect(
      parseDryRunProxyArgs([
        ...base,
        '--simulate-writes',
        '/tmp/run/slack.jsonl',
        '--write-replies',
        '{"send":{"ok":true}}',
      ]).simulateWrites
    ).toEqual({
      file: '/tmp/run/slack.jsonl',
      replies: { send: { ok: true } },
    });
    expect(parseDryRunProxyArgs(base).simulateWrites).toBeUndefined();
    expect(() =>
      parseDryRunProxyArgs([...base, '--write-replies', '{}'])
    ).toThrow('--write-replies needs --simulate-writes.');
    expect(() =>
      parseDryRunProxyArgs([...base, '--simulate-writes', 'relative.jsonl'])
    ).toThrow('--simulate-writes takes an absolute path.');
    expect(() =>
      parseDryRunProxyArgs([
        ...base,
        '--simulate-writes',
        '/tmp/x.jsonl',
        '--write-replies',
        '[1]',
      ])
    ).toThrow('--write-replies must be a JSON object.');
  });

  it('rejects plaintext upstreams off loopback', () => {
    expect(() =>
      parseDryRunProxyArgs([
        '--upstream-url',
        'http://127.0.0.1.attacker.example/mcp',
        '--name',
        'x',
      ])
    ).toThrow('https');
    expect(
      parseDryRunProxyArgs([
        '--upstream-url',
        'http://127.0.0.1:9/mcp',
        '--name',
        'x',
      ]).upstreamUrl
    ).toBe('http://127.0.0.1:9/mcp');
  });

  it('rejects both token sources and a missing env token', () => {
    expect(() =>
      parseDryRunProxyArgs([
        '--upstream-url',
        'https://a.example',
        '--name',
        'x',
        '--token-file',
        '/f',
        '--token-env',
        'E',
      ])
    ).toThrow('not both');
    expect(() =>
      parseDryRunProxyArgs(
        [
          '--upstream-url',
          'https://a.example',
          '--name',
          'x',
          '--token-env',
          'E',
        ],
        {}
      )
    ).toThrow('E is not set');
  });
});
