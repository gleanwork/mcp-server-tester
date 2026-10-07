import { afterEach, describe, expect, it } from 'vitest';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import { assertPlugin } from '../../plugins/plugin.js';
import {
  getConnector,
  grantIdentity,
  grantTargets,
  type ConnectorUse,
} from './connectors.js';
import type { ConnectorDefinition } from './types.js';

const client = async () => ({ clientId: 'c' });

function plugin(connectors: Record<string, unknown>) {
  return { meta: { name: '@acme/mst-plugin', namespace: 'acme' }, connectors };
}

describe('connector validation', () => {
  it('accepts each auth type', () => {
    expect(() =>
      assertPlugin(
        plugin({
          glean: {
            url: 'https://mcp.acme.example/mcp',
            auth: { type: 'oauth' },
          },
          github: {
            url: 'https://api.github.example/mcp/',
            auth: { type: 'oauth', flow: 'device', client },
          },
          pat: {
            url: 'https://pat.example/mcp',
            auth: { type: 'static', token: async () => 't' },
          },
          app: {
            url: 'https://app.example/mcp',
            auth: {
              type: 'client-credentials',
              tokenEndpoint: 'https://app.example/token',
              client,
            },
          },
          open: { url: 'https://open.example/mcp', auth: { type: 'none' } },
        }),
        'inline'
      )
    ).not.toThrow();
  });

  it.each([
    [{ auth: { type: 'oauth' } }, 'needs a url'],
    [
      { url: 'http://mcp.example/mcp', auth: { type: 'oauth' } },
      'must be https',
    ],
    [{ url: 'https://x.example' }, 'needs auth'],
    [
      { url: 'https://x.example', auth: { type: 'magic' } },
      'unknown auth type',
    ],
    [
      { url: 'https://x.example', auth: { type: 'static' } },
      'needs a token function',
    ],
    [
      { url: 'https://x.example', auth: { type: 'oauth', flow: 'device' } },
      'device sign-in needs auth.client',
    ],
    [
      { url: 'https://x.example', auth: { type: 'oauth' }, grant: 'a/b' },
      'grant must be a name',
    ],
    [
      { url: 'https://x.example', auth: { type: 'oauth' }, launch: 'node' },
      'launch must be a function',
    ],
  ])('rejects %j', (definition, message) => {
    expect(() => assertPlugin(plugin({ bad: definition }), 'inline')).toThrow(
      message
    );
  });
});

describe('getConnector', () => {
  afterEach(() => resetPluginsForTests());

  it('finds a plugin connector and explains a missing one', () => {
    const slack: ConnectorDefinition = {
      url: 'https://mcp.slack.example/mcp',
      auth: { type: 'oauth' },
    };
    installPlugins([plugin({ slack }) as never]);
    expect(getConnector('acme/connector/slack')).toBe(slack);
    expect(() => getConnector('slack')).toThrow('must be namespaced');
    expect(() => getConnector('acme/connector/jira')).toThrow(
      'Connector "acme/connector/jira" is not available. Available: acme/connector/slack.'
    );
    expect(() => getConnector('other/connector/jira')).toThrow(
      'needs the "other" plugin'
    );
  });
});

describe('grantTargets', () => {
  const google = (scopes: string[]): ConnectorDefinition => ({
    url: 'https://unused.example',
    grant: 'google',
    auth: { type: 'oauth', scopes, client },
  });

  it('gives connectors that share a grant one sign-in with all their scopes', () => {
    const uses: ConnectorUse[] = [
      {
        label: 'gmail',
        reference: 'acme/connector/gmail',
        connector: google(['gmail.readonly']),
        url: 'https://gmail.example/mcp',
      },
      {
        label: 'gdrive',
        reference: 'acme/connector/gdrive',
        connector: google(['drive.readonly', 'gmail.readonly']),
        url: 'https://drive.example/mcp',
      },
      {
        label: 'slack',
        reference: 'acme/connector/slack',
        connector: {
          url: 'https://slack.example/mcp',
          auth: { type: 'oauth' },
        },
        url: 'https://slack.example/mcp',
      },
    ];
    const targets = grantTargets(uses);
    expect(
      targets.map((t) => [t.key, t.name, t.servers.map((s) => s.label)])
    ).toEqual([
      ['acme.google', 'acme/google', ['gmail', 'gdrive']],
      ['acme.slack', 'acme/slack', ['slack']],
    ]);
    expect(targets[0]!.urls).toEqual([
      'https://gmail.example/mcp',
      'https://drive.example/mcp',
    ]);
    expect(targets[0]!.auth).toMatchObject({
      scopes: ['gmail.readonly', 'drive.readonly'],
    });
  });

  it('keys a scoped namespace safely', () => {
    const [target] = grantTargets([
      {
        label: 'x',
        reference: '@acme/evals/connector/x',
        connector: { url: 'https://x.example', auth: { type: 'oauth' } },
        url: 'https://x.example',
      },
    ]);
    expect(target!.key).toBe('acme.evals.x');
  });

  it('rejects a shared grant with different auth types', () => {
    expect(() =>
      grantTargets([
        {
          label: 'a',
          reference: 'acme/connector/a',
          connector: google([]),
          url: 'https://a.example',
        },
        {
          label: 'b',
          reference: 'acme/connector/b',
          connector: {
            url: 'https://b.example',
            grant: 'google',
            auth: { type: 'none' },
          },
          url: 'https://b.example',
        },
      ])
    ).toThrow('same auth type');
  });
});

describe('grantIdentity', () => {
  it('keys a grant by namespace and grant name', () => {
    const connector = {
      url: 'https://x.example',
      auth: { type: 'oauth' as const },
    };
    expect(
      grantIdentity({ reference: 'acme/connector/slack', connector })
    ).toEqual({
      key: 'acme.slack',
      name: 'acme/slack',
    });
    expect(
      grantIdentity({
        reference: 'acme/connector/gmail',
        connector: { ...connector, grant: 'google' },
      })
    ).toEqual({ key: 'acme.google', name: 'acme/google' });
  });
});
