import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  Client,
  InMemoryTransport,
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import {
  callToolNormalized,
  formatProtocolError,
  getToolProtocolError,
  isServerProtocolError,
  PROTOCOL_ERROR_META_KEY,
} from './callTool.js';

/** A real v2 client connected in memory to a real v2 server. */
async function connectedClient(
  register: (server: McpServer) => void
): Promise<Client> {
  const server = new McpServer({ name: 'call-tool-test', version: '1.0.0' });
  register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'mst-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('callToolNormalized (real SDK client and server)', () => {
  it('returns successful results unchanged', async () => {
    const client = await connectedClient((server) =>
      server.registerTool(
        'echo',
        { inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text', text }] })
      )
    );
    const result = await callToolNormalized(client, {
      name: 'echo',
      arguments: { text: 'hi' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    await client.close();
  });

  it('folds a server protocol error (unknown tool) into an error result', async () => {
    const client = await connectedClient(() => undefined);
    // The v2 server only answers tools/call once a tool exists.
    const withTool = await connectedClient((server) =>
      server.registerTool('echo', {}, async () => ({ content: [] }))
    );

    const result = await callToolNormalized(withTool, {
      name: 'nope',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const error = getToolProtocolError(result);
    expect(error?.code).toBe(-32602);
    expect(result.content).toEqual([
      { type: 'text', text: formatProtocolError(error!) },
    ]);
    await client.close();
    await withTool.close();
  });

  it('rethrows the SDK’s local output-schema validation errors', async () => {
    // A scripted server (the SDK's McpServer validates its own output) that
    // declares an output schema and then returns content violating it.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serverSide.onmessage = (message) => {
      const request = message as { id?: number; method?: string };
      if (request.id === undefined) return;
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'scripted', version: '1' },
            }
          : request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'typed',
                    inputSchema: { type: 'object' },
                    outputSchema: {
                      type: 'object',
                      properties: { count: { type: 'number' } },
                      required: ['count'],
                    },
                  },
                ],
              }
            : {
                content: [{ type: 'text', text: 'bad' }],
                structuredContent: { count: 'not a number' },
              };
      void serverSide.send({ jsonrpc: '2.0', id: request.id, result });
    };
    await serverSide.start();
    const client = new Client({ name: 'mst-test', version: '1.0.0' });
    await client.connect(clientSide);
    // Output validation uses the tools/list entry, as in real test runs.
    await client.listTools();

    const error = await callToolNormalized(client, {
      name: 'typed',
      arguments: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProtocolError);
    expect(isServerProtocolError(error)).toBe(false);
    expect((error as Error).message).toMatch(/output schema/);
    await client.close();
  });
});

describe('callToolNormalized (test doubles)', () => {
  it('passes request options through to the SDK', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const signal = new AbortController().signal;

    await callToolNormalized(
      { callTool } as unknown as Client,
      { name: 'echo', arguments: { a: 1 } },
      { signal }
    );

    expect(callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { a: 1 } },
      { signal }
    );
  });

  it('rethrows local SDK errors such as timeouts', async () => {
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, 'timed out');
    const callTool = vi.fn().mockRejectedValue(timeout);

    await expect(
      callToolNormalized({ callTool } as unknown as Client, {
        name: 'slow',
        arguments: {},
      })
    ).rejects.toBe(timeout);
  });

  it('rethrows protocol errors that did not come from request()', async () => {
    const local = new ProtocolError(-32602, 'raised locally');
    const callTool = vi.fn().mockRejectedValue(local);

    await expect(
      callToolNormalized({ callTool } as unknown as Client, {
        name: 'x',
        arguments: {},
      })
    ).rejects.toBe(local);
  });
});

describe('getToolProtocolError', () => {
  it('returns null for ordinary tool results', () => {
    expect(
      getToolProtocolError({ content: [], isError: true, _meta: {} })
    ).toBeNull();
    expect(getToolProtocolError({ content: [] })).toBeNull();
  });

  it('reads the recorded error', () => {
    expect(
      getToolProtocolError({
        content: [],
        isError: true,
        _meta: { [PROTOCOL_ERROR_META_KEY]: { code: -1, message: 'm' } },
      })
    ).toEqual({ code: -1, message: 'm' });
  });
});

describe('formatProtocolError', () => {
  it('renders the MCP error prefix and code', () => {
    expect(formatProtocolError({ code: -32601, message: 'nope' })).toBe(
      'MCP error -32601: nope'
    );
  });
});
