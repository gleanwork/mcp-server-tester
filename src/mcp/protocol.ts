import {
  InMemoryResponseCacheStore,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/client';
import type {
  Client,
  ClientOptions,
  ResponseCacheStore,
} from '@modelcontextprotocol/client';
import type {
  MCPProtocolInfo,
  ProtocolEra,
  ProtocolProbeOptions,
  ProtocolSetting,
} from '../types/index.js';
import { connectionOf } from './connection.js';

/** The first protocol revision of the modern (stateless) era. */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Legacy-era revisions the SDK can negotiate, newest first. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] =
  SUPPORTED_PROTOCOL_VERSIONS;

/** Modern-era revisions MST can pin. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = [
  FIRST_MODERN_PROTOCOL_VERSION,
];

/** Default protocol setting: the legacy `initialize` handshake. */
export const DEFAULT_PROTOCOL_SETTING: ProtocolSetting = 'legacy';

const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed dated revision string (`YYYY-MM-DD`). */
export function isProtocolRevision(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

/** Returns the era a dated revision belongs to. */
export function eraOfRevision(revision: string): ProtocolEra {
  // Dated revisions compare correctly as strings.
  return revision >= FIRST_MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy';
}

/**
 * SDK client options that implement a {@link ProtocolSetting}.
 */
export type ProtocolClientOptions = Pick<
  ClientOptions,
  'versionNegotiation' | 'supportedProtocolVersions'
>;

/**
 * Maps MST's `protocol` setting onto the SDK's version-negotiation options.
 *
 * | setting            | versionNegotiation         | supportedProtocolVersions |
 * | ------------------ | -------------------------- | ------------------------- |
 * | 'legacy' (default) | legacy                     | SDK default               |
 * | pre-2026 revision  | legacy                     | [revision]                |
 * | 2026+ revision     | { pin: revision }          | SDK default               |
 * | 'auto'             | auto (+ probe)             | SDK default               |
 */
export function resolveProtocolClientOptions(
  setting: ProtocolSetting = DEFAULT_PROTOCOL_SETTING,
  probe?: ProtocolProbeOptions
): ProtocolClientOptions {
  if (setting === 'legacy') {
    return { versionNegotiation: { mode: 'legacy' } };
  }
  if (setting === 'auto') {
    return {
      versionNegotiation: {
        mode: 'auto',
        ...(probe?.timeoutMs !== undefined
          ? { probe: { timeoutMs: probe.timeoutMs } }
          : {}),
      },
    };
  }
  if (!isProtocolRevision(setting)) {
    throw new Error(
      `Invalid protocol setting "${setting}". Use 'legacy', 'auto', or a revision like '2026-07-28'.`
    );
  }
  if (eraOfRevision(setting) === 'modern') {
    return { versionNegotiation: { mode: { pin: setting } } };
  }
  return {
    versionNegotiation: { mode: 'legacy' },
    supportedProtocolVersions: [setting],
  };
}

/**
 * Creates the response cache MST clients use: entries are stored but never
 * served as fresh.
 *
 * On 2026-07-28 connections the SDK serves list/read results from its cache
 * while their server-sent `ttlMs` is fresh. A tester wants every call to
 * reach the server, so entries are stored without `expiresAt` (which the SDK
 * treats as never fresh). They are still stored because the SDK builds its
 * `tools/list` index from the cache: `callTool()` uses it for output-schema
 * validation and, on 2026-07-28, `Mcp-Param-*` header mirroring.
 */
export function createTesterResponseCache(): ResponseCacheStore {
  const store = new InMemoryResponseCacheStore();
  return {
    get: (key) => store.get(key),
    set: (key, entry) =>
      store.set(key, {
        value: entry.value,
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
      }),
    delete: (key) => store.delete(key),
    evict: (method) => store.evict(method),
    clear: () => store.clear(),
  };
}

/**
 * Returns what a connected client requested and negotiated.
 */
export function getProtocolInfo(client: Client): MCPProtocolInfo {
  return {
    requested:
      connectionOf(client)?.requestedProtocol ?? DEFAULT_PROTOCOL_SETTING,
    negotiated: client.getNegotiatedProtocolVersion() ?? null,
    era: client.getProtocolEra() ?? null,
  };
}
