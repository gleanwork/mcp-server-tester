import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { openMCPClient, closeMCPClient } from '../../mcp/clientFactory.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  readyStdioServer,
  startReadinessHttpServer,
} from '../../../tests/mocks/readyServers.js';
import { linuxReadPolicies } from './linuxReadPolicy.js';

const stdio = { plugins: [], paths: {} };
const from = (servers: MCPConfig[], base = {}, proxy = false) =>
  linuxReadPolicies(servers, {}, stdio, base, new Map(), proxy);

describe('managed Linux read policies', () => {
  it('uses the worker-facing HTTP and stdio catalogs, scoped by server and variant', async () => {
    const http = await startReadinessHttpServer({
      tools: ['lookup', 'archive'],
    });
    onTestFinished(() => http.close());
    const a: MCPConfig = {
      label: 'docs',
      transport: 'http',
      serverUrl: http.url,
    };
    const b = {
      ...readyStdioServer({
        READINESS_TOOLS: 'lookup,dispatch,reclassify,forced,mixed',
        READINESS_WRITE_TOOL: '1',
      }),
      label: 'tickets',
    };
    b.args = [
      ...b.args!,
      '--dispatcher',
      'dispatch=method',
      '--always-write=reclassify',
      '--always-write',
      'forced',
      '--dispatcher=mixed=action',
    ];
    const rules = await from([a, b]);
    expect(Object.fromEntries(rules)).toEqual({
      docs: { '*': 'ask', archive: 'allow', lookup: 'allow' },
      tickets: { '*': 'ask', lookup: 'allow' },
    });
    expect(Object.fromEntries(await from([b]))).toEqual({
      tickets: { '*': 'ask', lookup: 'allow' },
    });
  });

  it('can dispatch two concurrent reads without granting a simulated Desktop a write or an unknown tool', async () => {
    const server = {
      ...readyStdioServer({
        READINESS_TOOLS: 'lookup',
        READINESS_WRITE_TOOL: '1',
      }),
      label: 'docs',
    };
    const policy = (await from([server])).get('docs')!;
    const upstream = await openMCPClient(server);
    try {
      const dispatch = vi.spyOn(upstream, 'callTool');
      // Desktop is the external boundary in this test: exact rules override
      // its wildcard. Calls that reach the fixture use the real MCP transport.
      const desktopCall = async (name: string, id: number) =>
        (policy[name] ?? policy['*']) === 'allow'
          ? upstream.callTool({ name, arguments: { id } })
          : 'needs-approval';
      const results = await Promise.all([
        desktopCall('lookup', 1),
        desktopCall('lookup', 2),
        desktopCall('save', 3),
        desktopCall('new_tool', 4),
      ]);
      expect(results).toEqual([
        expect.objectContaining({ content: [{ type: 'text', text: 'ok' }] }),
        expect.objectContaining({ content: [{ type: 'text', text: 'ok' }] }),
        'needs-approval',
        'needs-approval',
      ]);
      expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual([
        'lookup',
        'lookup',
      ]);
    } finally {
      await closeMCPClient(upstream);
    }
  });

  it.each(['lookup,LOOKUP', 'read_*', '*', 'constructor', '__proto__'])(
    'never installs an ambiguous or pattern rule from a catalog (%s)',
    async (names) => {
      await expect(
        from([readyStdioServer({ READINESS_TOOLS: names })])
      ).rejects.toThrow(/invalid MCP tool name|did not list its tools/);
    }
  );

  it('refuses duplicate server names, an existing image policy, and a failed catalog', async () => {
    const s = { ...readyStdioServer(), label: 'docs' };
    await expect(from([s, { ...s, label: 'DOCS' }])).rejects.toThrow(
      'Ambiguous managed MCP server'
    );
    await expect(
      from([s], {
        managedMcpServers: [
          { name: 'DOCS', toolPolicy: { lookup: 'blocked' } },
        ],
      })
    ).rejects.toThrow('existing MCP tool policy');
    await expect(
      from([{ ...s, env: { READINESS_LIST_ERROR: '1' } }])
    ).rejects.toThrow(
      'Cannot prepare read permissions: docs did not list its tools'
    );
  });

  it('does not probe or grant a metadata proxy or a server known only through the image’s credential helper', async () => {
    const http: MCPConfig = {
      label: 'docs',
      transport: 'http',
      serverUrl: 'https://unused.invalid/mcp',
    };
    expect(
      (
        await from([http], {
          managedMcpServers: [
            {
              name: 'docs',
              url: http.serverUrl,
              headersHelper: '/image/helper',
            },
          ],
        })
      ).get('docs')
    ).toEqual({ '*': 'ask' });
    expect((await from([http], {}, true)).get('docs')).toEqual({ '*': 'ask' });
  });
});
