import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvalManifest } from '../evalManifest.js';
import { createCoworkMcpPlan } from './config.js';

describe('Cowork example', () => {
  it('loads a complete, default-safe example using synthetic endpoints and independent token references', () => {
    const manifest = loadEvalManifest(
      fileURLToPath(
        new URL(
          '../../../examples/cowork-setup/multi-server.manifest.json',
          import.meta.url
        )
      )
    );
    expect(manifest.host).toEqual({
      type: 'cowork',
      driver: 'anthropic.claude.cowork.desktop-app.macos',
    });
    expect(manifest.coworkSetup).toBeUndefined();
    expect(manifest.servers).toEqual(
      ['search', 'calendar'].map((label) => ({
        transport: 'http',
        label,
        serverUrl: `https://${label}.example.test/mcp`,
        auth: { accessTokenEnv: `${label.toUpperCase()}_MCP_TOKEN` },
      }))
    );
    const settings = createCoworkMcpPlan(
      manifest.servers!,
      '/run/mst-example'
    ).settings;
    expect(settings.managedMcpServers).toHaveLength(2);
    expect(
      settings.managedMcpServers.every(
        (server) => server.toolPolicy === undefined
      )
    ).toBe(true);
  });
});
