import { describe, it, expect } from 'vitest';
import {
  Client,
  InMemoryTransport,
  ProtocolError,
} from '@modelcontextprotocol/client';
import {
  eraOfRevision,
  getProtocolInfo,
  isProtocolRevision,
  createTesterResponseCache,
  resolveProtocolClientOptions,
  setRequestedProtocol,
} from './protocol.js';

describe('resolveProtocolClientOptions', () => {
  it('defaults to the legacy initialize handshake', () => {
    expect(resolveProtocolClientOptions()).toEqual({
      versionNegotiation: { mode: 'legacy' },
    });
    expect(resolveProtocolClientOptions('legacy')).toEqual({
      versionNegotiation: { mode: 'legacy' },
    });
  });

  it('pins a legacy revision through supportedProtocolVersions', () => {
    expect(resolveProtocolClientOptions('2025-06-18')).toEqual({
      versionNegotiation: { mode: 'legacy' },
      supportedProtocolVersions: ['2025-06-18'],
    });
  });

  it('pins a modern revision through versionNegotiation', () => {
    expect(resolveProtocolClientOptions('2026-07-28')).toEqual({
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
  });

  it('maps auto to the probing mode, with an optional timeout', () => {
    expect(resolveProtocolClientOptions('auto')).toEqual({
      versionNegotiation: { mode: 'auto' },
    });
    expect(resolveProtocolClientOptions('auto', { timeoutMs: 500 })).toEqual({
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 500 } },
    });
  });

  it('rejects malformed settings', () => {
    expect(() => resolveProtocolClientOptions('latest')).toThrow(
      /Invalid protocol setting "latest"/
    );
  });
});

describe('eraOfRevision / isProtocolRevision', () => {
  it('classifies revisions by era', () => {
    expect(eraOfRevision('2024-11-05')).toBe('legacy');
    expect(eraOfRevision('2025-11-25')).toBe('legacy');
    expect(eraOfRevision('2026-07-28')).toBe('modern');
    expect(eraOfRevision('2027-01-01')).toBe('modern');
  });

  it('recognizes dated revisions only', () => {
    expect(isProtocolRevision('2026-07-28')).toBe(true);
    expect(isProtocolRevision('auto')).toBe(false);
    expect(isProtocolRevision('2026-7-28')).toBe(false);
  });
});

describe('createTesterResponseCache', () => {
  it('stores entries without freshness, so the SDK never serves them', async () => {
    const store = createTesterResponseCache();
    const key = { method: 'tools/list' };
    await store.set(key, {
      value: '{"tools":[]}',
      expiresAt: Date.now() + 60_000,
      scope: 'private',
    });

    const entry = await store.get(key);
    // Kept (the SDK's tools/list index reads it) ...
    expect(entry?.value).toBe('{"tools":[]}');
    expect(entry?.scope).toBe('private');
    // ... but never fresh: the SDK treats a missing expiresAt as stale.
    expect(entry?.expiresAt).toBeUndefined();
  });

  it('keeps the SDK output-schema validation working', async () => {
    // Scripted server: declares an output schema, then violates it.
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
            : { content: [], structuredContent: { count: 'nope' } };
      void serverSide.send({ jsonrpc: '2.0', id: request.id, result });
    };
    await serverSide.start();
    const client = new Client(
      { name: 'mst-test', version: '1' },
      { responseCacheStore: createTesterResponseCache() }
    );
    await client.connect(clientSide);
    await client.listTools();

    await expect(
      client.callTool({ name: 'typed', arguments: {} })
    ).rejects.toBeInstanceOf(ProtocolError);
    await client.close();
  });
});

describe('getProtocolInfo', () => {
  function fakeClient(
    negotiated: string | undefined,
    era: 'legacy' | 'modern' | undefined
  ): Client {
    return {
      getNegotiatedProtocolVersion: () => negotiated,
      getProtocolEra: () => era,
    } as unknown as Client;
  }

  it('reports the default request and the negotiated result', () => {
    expect(getProtocolInfo(fakeClient('2025-11-25', 'legacy'))).toEqual({
      requested: 'legacy',
      negotiated: '2025-11-25',
      era: 'legacy',
    });
  });

  it('reports the recorded request', () => {
    const client = fakeClient('2026-07-28', 'modern');
    setRequestedProtocol(client, 'auto');
    expect(getProtocolInfo(client)).toEqual({
      requested: 'auto',
      negotiated: '2026-07-28',
      era: 'modern',
    });
  });

  it('returns nulls before connect', () => {
    expect(getProtocolInfo(fakeClient(undefined, undefined))).toEqual({
      requested: 'legacy',
      negotiated: null,
      era: null,
    });
  });
});
