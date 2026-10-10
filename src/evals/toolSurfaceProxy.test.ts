import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import type { ClientRunResult } from './evalFrameworkTypes.js';
import { prepareClientBatch } from './prepareClientBatch.js';
import {
  settleProxiedTrace,
  startToolSurfaceProxy,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/usecases/fixtures'
);

function catalog(name: string, label: string): MCPConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [
      path.join(FIXTURES, 'catalogServer.mjs'),
      path.join(FIXTURES, 'catalogs', `${name}.json`),
    ],
    label,
  };
}

const proxies: ToolSurfaceProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function start(servers: MCPConfig[]) {
  const proxy = await startToolSurfaceProxy(servers, {
    id: 'v2',
    tools: {
      search: { description: 'Search every connected source.' },
      find_skills: { name: 'find_more_skills_and_tools' },
    },
  });
  proxies.push(proxy);
  return proxy;
}

describe('startToolSurfaceProxy', () => {
  it.each(['legacy', '2026-07-28'] as const)(
    'serves the variant to a %s client and records calls under original names',
    async (protocol) => {
      const proxy = await start([catalog('docs', 'docs')]);
      const [config] = proxy.serversFor('case-1');
      expect(config).toMatchObject({ transport: 'http', label: 'docs' });
      expect((config as { serverUrl: string }).serverUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\//
      );

      const client = await createMCPClientForConfig({ ...config!, protocol });
      try {
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toContain('find_more_skills_and_tools');
        expect(names).not.toContain('find_skills');
        expect(tools.find((tool) => tool.name === 'search')?.description).toBe(
          'Search every connected source.'
        );

        const result = await client.callTool({
          name: 'find_more_skills_and_tools',
          arguments: { query: 'create ticket' },
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result.content)).toContain('create');

        await expect(
          client.callTool({ name: 'find_skills', arguments: {} })
        ).rejects.toThrow(/Unknown tool: find_skills/);
      } finally {
        await closeMCPClient(client);
      }

      const activity = proxy.activity('case-1');
      expect(activity.listedTools).toBe(true);
      expect(activity.calls).toMatchObject([
        {
          server: 'docs',
          name: 'find_skills',
          rawName: 'find_more_skills_and_tools',
          arguments: { query: 'create ticket' },
          isError: false,
        },
      ]);
      expect(proxy.activity('case-2')).toEqual({
        listedTools: false,
        calls: [],
      });
      expect(proxy.originalName('find_more_skills_and_tools', 'docs')).toBe(
        'find_skills'
      );
    },
    30_000
  );

  it('rejects a variant that does not fit the servers, and closes them', async () => {
    await expect(
      startToolSurfaceProxy([catalog('docs', 'docs')], {
        id: 'bad',
        tools: { missing: { description: 'x' } },
      })
    ).rejects.toThrow('overrides unknown tool "missing"');
  }, 30_000);

  it('answers 404 off its endpoints, and closes once', async () => {
    const proxy = await start([catalog('docs', 'docs')]);
    const url = new URL(
      (proxy.serversFor('s')[0] as { serverUrl: string }).serverUrl
    );
    for (const path of [
      '/not-the-token/s/0/mcp',
      url.pathname.replace('/0/', '/9/'),
    ]) {
      const response = await fetch(`${url.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(404);
    }
    proxies.splice(proxies.indexOf(proxy), 1);
    const closing = proxy.close();
    expect(proxy.close()).toBe(closing);
    await closing;
  }, 30_000);
});

function stubProxy(
  listedTools = true,
  renames: Record<string, string> = { find_more: 'find_skills' }
): ToolSurfaceProxy & { started: number } {
  const ended: string[] = [];
  return {
    started: 0,
    serversFor: (scope) => [
      { transport: 'http', serverUrl: `http://127.0.0.1:1/t/${scope}/0/mcp` },
    ],
    activity: () => ({ listedTools, calls: [] }),
    endScope: (scope) => {
      ended.push(scope);
      return { listedTools, calls: [] };
    },
    originalName: (name) => renames[name],
    close: async () => {},
  };
}

const call = (name: string, server?: string) => ({
  kind: 'tool_call' as const,
  source: 'mcp' as const,
  name,
  ...(server !== undefined ? { server } : {}),
  arguments: {},
});

describe('settleProxiedTrace', () => {
  const two: MCPConfig[] = [catalog('docs', 'docs'), catalog('docs', 'b')];

  it('maps calls named by server field, label prefix, or the one server', () => {
    const trace: ClientRunResult = {
      finalText: '',
      events: [
        call('find_more', 'docs'),
        call('docs.find_more'),
        call('other'),
      ],
    };
    expect(
      settleProxiedTrace(trace, stubProxy(), true, two, 'v').events
    ).toMatchObject([
      { name: 'find_skills', server: 'docs', rawName: 'find_more' },
      { name: 'docs.find_skills', rawName: 'docs.find_more' },
      { name: 'other' },
    ]);
    const unlabelled: MCPConfig[] = [{ transport: 'stdio', command: 'x' }];
    expect(
      settleProxiedTrace(
        { finalText: '', events: [call('find_more', 'mcp-server')] },
        stubProxy(),
        true,
        unlabelled,
        'v'
      ).events
    ).toMatchObject([{ name: 'find_skills', server: 'mcp-server' }]);
  });

  it('fails a request that never listed tools, unless the client already failed', () => {
    expect(
      settleProxiedTrace(
        { finalText: '', events: [] },
        stubProxy(false),
        false,
        two,
        'v'
      ).error
    ).toContain('didn\'t see tool variant "v"');
    expect(
      settleProxiedTrace(
        { finalText: '', events: [], error: 'client crashed' },
        stubProxy(false),
        false,
        two,
        'v'
      ).error
    ).toBe('client crashed');
  });
});

describe('prepareClientBatch with a tool variant', () => {
  const evalConfig = { name: 'm', datasets: [] };
  const servers: MCPConfig[] = [catalog('docs', 'docs')];

  it('gives each request its own proxy scope and settles each trace', async () => {
    const seen: string[] = [];
    const proxy = stubProxy();
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        runBatch: async (requests) =>
          requests.map((request) => {
            seen.push(
              (request.input.servers[0] as { serverUrl: string }).serverUrl
            );
            return { finalText: '', events: [call('find_more')] };
          }),
      },
      [
        { id: 'a', input: 'x', trials: 2 },
        { id: 'b', input: 'y' },
      ],
      { type: 'test/batch' },
      servers,
      { evalConfig },
      { id: 'v', proxy: async () => proxy }
    );
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((url) => url.startsWith('http://127.0.0.1:1/'))).toBe(
      true
    );
    expect(queues?.get('a')?.[0]?.events).toMatchObject([
      { name: 'find_skills', rawName: 'find_more' },
    ]);
  });

  it('reports each settled trace as the client finishes it', async () => {
    const reported: Array<{ id: string; trace: ClientRunResult }> = [];
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        runBatch: async (requests, context) => {
          const traces: ClientRunResult[] = [];
          for (const [index] of requests.entries()) {
            const trace = { finalText: '', events: [call('find_more')] };
            await context.reportResult?.(index, trace);
            // Reported before the next request runs.
            expect(reported).toHaveLength(index + 1);
            traces.push(trace);
          }
          return traces;
        },
      },
      [
        { id: 'a', input: 'x', trials: 2 },
        { id: 'b', input: 'y' },
      ],
      { type: 'test/batch' },
      servers,
      { evalConfig },
      { id: 'v', proxy: async () => stubProxy() },
      {
        onTrace: async (request, trace) => {
          reported.push({ id: `${request.caseId}/${request.trial}`, trace });
        },
      }
    );
    expect(reported.map(({ id }) => id)).toEqual(['a/0', 'a/1', 'b/0']);
    // Settled, like the trace the eval grades.
    expect(reported[0]?.trace).toEqual(queues?.get('a')?.[0]);
    expect(reported[0]?.trace.events).toMatchObject([
      { name: 'find_skills', rawName: 'find_more' },
    ]);
  });

  it('goes on with the batch when saving a trace fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        runBatch: async (requests, context) => {
          for (const [index] of requests.entries())
            await context.reportResult?.(index, { finalText: '', events: [] });
          return requests.map(() => ({ finalText: 'done', events: [] }));
        },
      },
      [{ id: 'a', input: 'x' }],
      { type: 'test/batch' },
      [],
      { evalConfig },
      undefined,
      {
        onTrace: async () => {
          throw new Error('disk full');
        },
      }
    );
    expect(queues?.get('a')?.[0]?.finalText).toBe('done');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    warn.mockRestore();
  });

  it('fails each request whose client never listed tools', async () => {
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        runBatch: async (requests) =>
          requests.map(() => ({ finalText: '', events: [] })),
      },
      [{ id: 'a', input: 'x' }],
      { type: 'test/batch' },
      servers,
      { evalConfig },
      { id: 'v', proxy: async () => stubProxy(false) }
    );
    expect(queues?.get('a')?.[0]?.error).toContain('tool variant "v"');
  });
});

describe('settleProxiedTrace tool searches', () => {
  it('records the tools a search found under their original names', () => {
    const settled = settleProxiedTrace(
      {
        finalText: '',
        events: [
          {
            kind: 'tool_search',
            source: 'builtin',
            name: 'ToolSearch',
            results: [
              { name: 'find_more' },
              { name: 'search', server: 'docs' },
            ],
          },
        ],
      },
      stubProxy(true, { find_more: 'find_skills' }),
      true,
      [catalog('docs', 'docs')],
      'v'
    );
    expect(settled.events[0]?.results).toEqual([
      { name: 'find_skills' },
      { name: 'search', server: 'docs' },
    ]);
  });
});

describe('a batch client that connects to one server set for the batch', () => {
  const evalConfig = { name: 'm', datasets: [] };

  /** Lists tools from each server, as a client or a readiness probe would. */
  async function listFrom(servers: MCPConfig[]) {
    for (const config of servers) {
      const client = await createMCPClientForConfig(config);
      try {
        await client.listTools();
      } finally {
        await closeMCPClient(client);
      }
    }
  }

  async function runBatchWith(
    connect: (endpoints: {
      servers: MCPConfig[];
      check: MCPConfig[];
    }) => Promise<void>
  ) {
    const proxy = await start([catalog('docs', 'docs')]);
    const seen: string[] = [];
    const queues = await prepareClientBatch(
      {
        schema: z.object({}),
        serversPerBatch: true,
        runBatch: async (requests) => {
          for (const request of requests)
            seen.push(
              (request.input.servers[0] as { serverUrl: string }).serverUrl
            );
          await connect({
            servers: requests[0]!.input.servers,
            check: requests[0]!.input.checkServers!,
          });
          return requests.map(() => ({ finalText: '', events: [] }));
        },
      },
      [
        { id: 'a', input: 'x', trials: 2 },
        { id: 'b', input: 'y' },
      ],
      { type: 'test/batch' },
      [catalog('docs', 'docs')],
      { evalConfig },
      { id: 'v2', proxy: async () => proxy }
    );
    return { queues: queues!, seen };
  }

  it('serves the whole batch on one endpoint and checks once that the client listed tools', async () => {
    const { queues, seen } = await runBatchWith(async ({ servers, check }) => {
      expect(check[0]).not.toEqual(servers[0]);
      expect(check[0]).toMatchObject({ label: 'docs' });
      await listFrom(check);
      await listFrom(servers);
    });
    expect(new Set(seen).size).toBe(1);
    for (const id of ['a', 'b'])
      for (const trace of queues.get(id)!) expect(trace.error).toBeUndefined();
  });

  it("doesn't take MST's own check for the client listing tools", async () => {
    const { queues } = await runBatchWith(async ({ check }) => {
      await listFrom(check);
    });
    for (const id of ['a', 'b'])
      for (const trace of queues.get(id)!)
        expect(trace.error).toContain('tool variant "v2"');
  });
});
