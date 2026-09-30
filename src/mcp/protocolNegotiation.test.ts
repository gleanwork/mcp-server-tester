import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeMCPClient, createMCPClientForConfig } from './clientFactory.js';
import { getProtocolInfo } from './protocol.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { ProtocolSetting } from '../types/index.js';

/**
 * Integration tests: MST's client against the dual-era mock server over stdio,
 * covering the spec's client/server compatibility matrix
 * (docs/specification/2026-07-28/basic/versioning.mdx).
 */
const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/dualEraServer.ts'
);

function config(
  serverEra: 'dual' | 'legacy' | 'modern',
  protocol: ProtocolSetting
): MCPConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', mock],
    env: { MOCK_ERA: serverEra },
    quiet: true,
    protocol,
  };
}

async function connect(
  serverEra: 'dual' | 'legacy' | 'modern',
  protocol: ProtocolSetting
) {
  const client = await createMCPClientForConfig(config(serverEra, protocol));
  try {
    const { tools } = await client.listTools();
    return { info: getProtocolInfo(client), toolCount: tools.length };
  } finally {
    await closeMCPClient(client);
  }
}

describe('protocol negotiation (stdio, dual-era mock)', () => {
  it.each([
    ['legacy', 'legacy', '2025-11-25'],
    ['2025-06-18', 'legacy', '2025-06-18'],
    ['2026-07-28', 'modern', '2026-07-28'],
    ['auto', 'modern', '2026-07-28'],
  ] as const)(
    'dual-era server × %s → %s/%s',
    async (protocol, era, negotiated) => {
      const { info, toolCount } = await connect('dual', protocol);
      expect(info).toEqual({ requested: protocol, negotiated, era });
      expect(toolCount).toBe(4);
    },
    30_000
  );

  it('auto falls back to legacy against a legacy-only server', async () => {
    const { info } = await connect('legacy', 'auto');
    expect(info.era).toBe('legacy');
  }, 30_000);

  it('a modern pin fails against a legacy-only server, with a hint', async () => {
    await expect(connect('legacy', '2026-07-28')).rejects.toThrow(
      /did not accept protocol "2026-07-28".*Use protocol: 'legacy'/s
    );
  }, 30_000);

  describe('over HTTP against a legacy-only server', () => {
    async function withLegacyHttpServer<T>(
      run: (serverUrl: string) => Promise<T>
    ): Promise<T> {
      const child = spawn(
        process.execPath,
        [path.join(path.dirname(mock), 'rawLegacyServer.mjs'), '--http', '0'],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      try {
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('no server')),
            10_000
          );
          child.stderr.on('data', (chunk: Buffer) => {
            const found = /raw legacy server on (\S+)/.exec(chunk.toString());
            if (found?.[1]) {
              clearTimeout(timer);
              resolve(found[1]);
            }
          });
        });
        return await run(url);
      } finally {
        child.kill();
      }
    }

    it('a modern pin fails with a hint (no HTTP+SSE fallback)', async () => {
      await withLegacyHttpServer(async (serverUrl) => {
        await expect(
          createMCPClientForConfig({
            transport: 'http',
            serverUrl,
            protocol: '2026-07-28',
          })
        ).rejects.toThrow(/did not accept protocol "2026-07-28"/);
      });
    }, 30_000);

    it('auto falls back to legacy', async () => {
      await withLegacyHttpServer(async (serverUrl) => {
        const client = await createMCPClientForConfig({
          transport: 'http',
          serverUrl,
          protocol: 'auto',
        });
        try {
          expect(getProtocolInfo(client).era).toBe('legacy');
        } finally {
          await closeMCPClient(client);
        }
      });
    }, 30_000);
  });

  it('legacy fails against a modern-only server, naming what it supports', async () => {
    await expect(connect('modern', 'legacy')).rejects.toThrow(
      /does not support protocol "2025-11-25" \(it supports: 2026-07-28\)/
    );
  }, 30_000);
});
