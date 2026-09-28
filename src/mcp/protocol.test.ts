import { describe, it, expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import {
  eraOfRevision,
  getProtocolInfo,
  isProtocolRevision,
  NO_RESPONSE_CACHE,
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

describe('NO_RESPONSE_CACHE', () => {
  it('never returns a cached entry', async () => {
    const key = { method: 'tools/list' };
    await NO_RESPONSE_CACHE.set(key, { value: '{}' });
    expect(await NO_RESPONSE_CACHE.get(key)).toBeUndefined();
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
