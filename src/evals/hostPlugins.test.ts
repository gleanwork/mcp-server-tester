import { describe, expect, it } from 'vitest';
import {
  HostPluginSchema,
  HostPluginsSchema,
  assertCoworkHostPlugins,
  coworkPluginMarketplace,
  hostPluginMcpServers,
  resolveHostPluginCredentials,
  type HostPlugin,
} from './hostPlugins.js';

const SHA = 'b'.repeat(40);
const base: HostPlugin = {
  name: 'acme',
  marketplace: { source: 'Acme/Plugins', ref: SHA },
};
const override = {
  url: 'https://example.test/mcp/eval',
  auth: { accessTokenEnv: 'ACME_TOKEN' },
  env: { ACME_URL: '${url}', ACME_DATA: '${dataDir}' },
  files: { 'creds.json': { token: '${bearerToken}' } },
};
const withMcp: HostPlugin = { ...base, mcp: { acme_mcp: override } };

describe('host plugin schema', () => {
  it('accepts the declarative override and defaults minTools to 1', () => {
    expect(hostPluginMcpServers([withMcp])).toEqual([
      {
        plugin: 'acme',
        server: 'acme_mcp',
        override: { ...override, minTools: 1 },
      },
    ]);
  });

  it('requires a full commit SHA for Git marketplaces', () => {
    for (const marketplace of [
      { source: 'o/r' },
      { source: 'o/r', ref: 'main' },
    ])
      expect(HostPluginSchema.safeParse({ ...base, marketplace }).success).toBe(
        false
      );
    expect(
      HostPluginSchema.safeParse({
        ...base,
        marketplace: { source: '/opt/plugins' },
      }).success
    ).toBe(true);
  });

  it.each([
    ['an unknown placeholder', { env: { X: '${HOME}' } }],
    ['a malformed placeholder', { env: { X: '${url' } }],
    ['a token in env', { env: { X: '${bearerToken}' } }],
    ['a token without auth', { auth: undefined }],
    ['a nested file path', { files: { '../x': {} } }],
    ['a hidden file', { files: { '.x': {} } }],
    ['an unknown placeholder in a file', { files: { a: { k: '${PATH}' } } }],
    ['a URL with credentials', { url: 'https://u:p@example.test/mcp' }],
    ['plain HTTP', { url: 'http://example.test/mcp' }],
    ['a zero tool minimum', { minTools: 0 }],
    ['an unknown key', { replaces: 'direct' }],
  ])('rejects %s', (_kind, change) => {
    const plugin = { ...base, mcp: { acme_mcp: { ...override, ...change } } };
    expect(HostPluginSchema.safeParse(plugin).success).toBe(false);
  });

  it('rejects duplicate plugins and duplicate server names across plugins', () => {
    expect(HostPluginsSchema.safeParse([base, base]).success).toBe(false);
    expect(
      HostPluginsSchema.safeParse([withMcp, { ...withMcp, name: 'other' }])
        .success
    ).toBe(false);
  });
});

describe('host plugin credentials', () => {
  it('resolves tokens from the same environment as direct servers', () => {
    expect(
      resolveHostPluginCredentials([withMcp], { ACME_TOKEN: 't' })
    ).toEqual({ 'acme/acme_mcp': 't' });
    expect(resolveHostPluginCredentials([base], {})).toEqual({});
  });

  it.each([{}, { ACME_TOKEN: '' }, { ACME_TOKEN: 'a\nb' }])(
    'fails closed on a missing or invalid token',
    (env) => {
      expect(() => resolveHostPluginCredentials([withMcp], env)).toThrow(
        expect.objectContaining({ code: 'plugin_credential_missing' })
      );
    }
  );
});

describe('Cowork plugin marketplaces', () => {
  it('pins GitHub and Git sources as required', () => {
    expect(coworkPluginMarketplace(base)).toEqual({
      source: 'github',
      repo: 'acme/plugins',
      ref: SHA,
      installationPreference: 'required',
    });
    expect(
      coworkPluginMarketplace({
        ...base,
        marketplace: { source: 'https://git.example/p.git', ref: SHA },
      })
    ).toEqual({
      source: 'git',
      url: 'https://git.example/p.git',
      ref: SHA,
      installationPreference: 'required',
    });
  });

  it('rejects local sources and MCP overrides that Cowork cannot apply', () => {
    expect(() =>
      assertCoworkHostPlugins([
        { ...base, marketplace: { source: '/opt/p', ref: SHA } },
      ])
    ).toThrow(expect.objectContaining({ code: 'plugin_unsupported' }));
    expect(() => assertCoworkHostPlugins([withMcp])).toThrow(
      expect.objectContaining({ code: 'plugin_unsupported' })
    );
    expect(() => assertCoworkHostPlugins([base])).not.toThrow();
  });
});
