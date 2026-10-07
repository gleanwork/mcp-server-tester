import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuthServer, type FakeAuthServer } from './fakeAuthServer.js';
import {
  MissingGrantError,
  accessToken,
  grantState,
  revokeGrant,
  signIn,
  type GrantTarget,
  type SignInIO,
} from './grants.js';
import { defaultGrantsDirectory, localCredentialStore } from './localStore.js';
import type { CredentialStore } from './types.js';

let dir: string;
let store: CredentialStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-grants-'));
  store = localCredentialStore(join(dir, 'grants'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A person who approves whatever the browser shows. */
function approvingIO(auth: FakeAuthServer, lines: string[] = []): SignInIO {
  return {
    print: (line) => lines.push(line),
    openUrl: async (url) => {
      if (url.startsWith(`${auth.origin}/authorize`)) await auth.approve(url);
    },
  };
}

function target(
  auth: FakeAuthServer,
  overrides: Partial<GrantTarget> = {}
): GrantTarget {
  return {
    key: 'acme.vendor',
    name: 'acme/vendor',
    urls: [`${auth.origin}/mcp`],
    auth: { type: 'oauth' },
    ...overrides,
  };
}

describe('signIn (authorization code)', () => {
  it('registers a client, runs PKCE, and stores the grant', async () => {
    const auth = fakeAuthServer();
    const lines: string[] = [];
    const grant = await signIn(target(auth), store, approvingIO(auth, lines), {
      fetch: auth.fetch,
    });
    expect(auth.registered).toEqual(['client-1']);
    expect(grant).toMatchObject({
      version: 1,
      type: 'oauth',
      clientId: 'client-1',
      tokenEndpoint: `${auth.origin}/token`,
      revocationEndpoint: `${auth.origin}/revoke`,
    });
    expect(grant.refreshToken).toMatch(/^refresh-/);
    // Scopes the server advertises, plus the refresh scope.
    expect(auth.lastAuthorization?.searchParams.get('scope')).toBe(
      'read write offline_access'
    );
    expect(auth.lastAuthorization?.searchParams.get('resource')).toBe(
      `${auth.origin}/mcp`
    );
    expect(auth.lastAuthorization?.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/localhost:\d+\/callback$/
    );
    expect(await store.get('acme.vendor')).toEqual(grant);
    const stat = await fs.stat(join(dir, 'grants', 'acme.vendor.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toContain(grant.refreshToken!);
  });

  it('uses the connector client, scopes, issuer, redirect port and params', async () => {
    const auth = fakeAuthServer({
      clientSecret: 'installed-app-secret',
      resourceMetadata: false,
    });
    const port = 30000 + Math.floor(Math.random() * 20000);
    await signIn(
      target(auth, {
        urls: ['https://gmail.example/mcp/v1'],
        auth: {
          type: 'oauth',
          issuer: auth.origin,
          scopes: ['gmail.readonly'],
          refreshScope: null,
          redirectPort: port,
          authorizationParams: { access_type: 'offline', prompt: 'consent' },
          client: async () => ({
            clientId: 'google-client',
            clientSecret: 'installed-app-secret',
          }),
        },
      }),
      store,
      approvingIO(auth),
      { fetch: auth.fetch }
    );
    const sent = auth.lastAuthorization!.searchParams;
    expect(auth.registered).toEqual([]);
    expect(sent.get('client_id')).toBe('google-client');
    expect(sent.get('scope')).toBe('gmail.readonly');
    expect(sent.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);
    expect(sent.get('access_type')).toBe('offline');
    expect(sent.get('prompt')).toBe('consent');
    expect(auth.tokenRequests[0]?.client_secret).toBe('installed-app-secret');
  });

  it('omits the resource indicator for a grant shared by several servers', async () => {
    const auth = fakeAuthServer();
    await signIn(
      target(auth, {
        urls: ['https://a.example/mcp', 'https://b.example/mcp'],
        auth: {
          type: 'oauth',
          issuer: auth.origin,
          client: async () => ({ clientId: 'c' }),
        },
      }),
      store,
      approvingIO(auth),
      { fetch: auth.fetch }
    );
    expect(auth.lastAuthorization?.searchParams.has('resource')).toBe(false);
  });

  it('replaces an older grant and revokes it', async () => {
    const auth = fakeAuthServer();
    const first = await signIn(target(auth), store, approvingIO(auth), {
      fetch: auth.fetch,
    });
    const second = await signIn(target(auth), store, approvingIO(auth), {
      fetch: auth.fetch,
    });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(auth.revoked).toEqual([first.refreshToken]);
  });

  it('fails without a client when the server offers no registration', async () => {
    const auth = fakeAuthServer();
    const noDcr: typeof auth.fetch = async (input, init) => {
      const response = await auth.fetch(input, init);
      if (
        new URL(new Request(input, init).url).pathname !==
        '/.well-known/oauth-authorization-server'
      )
        return response;
      const body = (await response.json()) as Record<string, unknown>;
      delete body.registration_endpoint;
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await expect(
      signIn(target(auth), store, approvingIO(auth), { fetch: noDcr })
    ).rejects.toThrow('must provide a client');
  });
});

describe('signIn (device code)', () => {
  it('polls through authorization_pending and stores a long-lived token', async () => {
    const auth = fakeAuthServer({ noRefreshToken: true, pendingPolls: 2 });
    const lines: string[] = [];
    const grant = await signIn(
      target(auth, {
        auth: {
          type: 'oauth',
          flow: 'device',
          scopes: ['repo'],
          refreshScope: null,
          client: async () => ({ clientId: 'gh-client' }),
        },
      }),
      store,
      approvingIO(auth, lines),
      { fetch: auth.fetch, sleep: async () => {} }
    );
    expect(grant.type).toBe('token');
    expect(grant.refreshToken).toBeUndefined();
    expect(lines.join('\n')).toContain('ABCD-1234');
    expect(auth.tokenRequests).toHaveLength(3);
  });
});

describe('accessToken', () => {
  it('reuses the cached token while it lasts, then refreshes', async () => {
    const auth = fakeAuthServer({ expiresIn: 3600 });
    const t = target(auth);
    const grant = await signIn(t, store, approvingIO(auth), {
      fetch: auth.fetch,
    });
    let now = Date.now();
    const cached = await accessToken(t, store, {
      fetch: auth.fetch,
      now: () => now,
    });
    expect(cached.accessToken).toBe(grant.accessToken);
    expect(auth.tokenRequests).toHaveLength(1);

    now += 3600_000;
    const refreshed = await accessToken(t, store, {
      fetch: auth.fetch,
      now: () => now,
    });
    expect(refreshed.accessToken).not.toBe(grant.accessToken);
    expect(auth.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
      client_id: 'client-1',
    });
  });

  it('redeems a rotating refresh token once, even when runs refresh at the same time', async () => {
    const auth = fakeAuthServer({ rotate: true });
    const t = target(auth);
    await signIn(t, store, approvingIO(auth), { fetch: auth.fetch });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        accessToken(t, store, { fetch: auth.fetch, force: true })
      )
    );
    const refreshes = auth.tokenRequests.filter(
      (r) => r.grant_type === 'refresh_token'
    );
    // Each refresh used a different (the then-current) refresh token.
    expect(new Set(refreshes.map((r) => r.refresh_token)).size).toBe(
      refreshes.length
    );
    expect(
      results.every((r) => auth.validAccessTokens.has(r.accessToken))
    ).toBe(true);
    const stored = await store.get(t.key);
    expect(stored?.refreshToken).not.toBe(refreshes[0]?.refresh_token);
  });

  it('asks to sign in again when the provider revoked the grant', async () => {
    const auth = fakeAuthServer();
    const t = target(auth);
    await signIn(t, store, approvingIO(auth), { fetch: auth.fetch });
    auth.revokeAll();
    const error = await accessToken(t, store, {
      fetch: auth.fetch,
      force: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingGrantError);
    expect((error as MissingGrantError).reason).toBe('revoked');
  });

  it('reads Slack-style 200 errors as failures', async () => {
    const auth = fakeAuthServer({ slackStyleErrors: true });
    const t = target(auth);
    await signIn(t, store, approvingIO(auth), { fetch: auth.fetch });
    auth.revokeAll();
    const error = await accessToken(t, store, {
      fetch: auth.fetch,
      force: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingGrantError);
    expect((error as MissingGrantError).reason).toBe('revoked');
  });

  it('fails with MissingGrantError before sign-in', async () => {
    const auth = fakeAuthServer();
    await expect(
      accessToken(target(auth), store, { fetch: auth.fetch })
    ).rejects.toBeInstanceOf(MissingGrantError);
  });

  it('mints client-credentials tokens and calls static token()', async () => {
    const auth = fakeAuthServer();
    const cc = await accessToken(
      target(auth, {
        auth: {
          type: 'client-credentials',
          tokenEndpoint: `${auth.origin}/token`,
          client: async () => ({ clientId: 'app', clientSecret: 'cc-secret' }),
        },
      }),
      store,
      { fetch: auth.fetch }
    );
    expect(cc.accessToken).toMatch(/^cc-/);
    const fixed = await accessToken(
      target(auth, {
        auth: { type: 'static', token: async () => ' pat-123 ' },
      }),
      store
    );
    expect(fixed.accessToken).toBe('pat-123');
  });
});

describe('grantState and revokeGrant', () => {
  it('reports missing, valid and plugin-managed grants', async () => {
    const auth = fakeAuthServer();
    const t = target(auth);
    expect(await grantState(t, store)).toEqual({ state: 'missing' });
    await signIn(t, store, approvingIO(auth), { fetch: auth.fetch });
    expect(await grantState(t, store)).toMatchObject({
      state: 'valid',
      refreshable: true,
    });
    expect(
      await grantState(
        target(auth, { auth: { type: 'static', token: async () => 'x' } }),
        store
      )
    ).toEqual({ state: 'plugin' });
    expect(
      await grantState(target(auth, { auth: { type: 'none' } }), store)
    ).toEqual({
      state: 'none',
    });
  });

  it('revokes at the provider and deletes the grant', async () => {
    const auth = fakeAuthServer();
    const t = target(auth);
    const grant = await signIn(t, store, approvingIO(auth), {
      fetch: auth.fetch,
    });
    expect(await revokeGrant(t, store, { fetch: auth.fetch })).toBe(true);
    expect(auth.revoked).toEqual([grant.refreshToken]);
    expect(await store.get(t.key)).toBeUndefined();
    expect(await revokeGrant(t, store, { fetch: auth.fetch })).toBe(false);
  });
});

describe('localCredentialStore', () => {
  it('rejects bad keys and a grant file other users can read', async () => {
    await expect(store.get('../escape')).rejects.toThrow('Invalid grant key');
    await store.put('acme.x', {
      version: 1,
      type: 'token',
      accessToken: 't',
      scopes: [],
      resource: 'https://x.example',
      signedInAt: new Date().toISOString(),
    });
    await fs.chmod(join(dir, 'grants', 'acme.x.json'), 0o644);
    await expect(store.get('acme.x')).rejects.toThrow(
      'readable by other users'
    );
  });
});

describe('defaultGrantsDirectory', () => {
  it('honours MST_CREDENTIALS_DIR, else uses the home directory', () => {
    expect(defaultGrantsDirectory({ MST_CREDENTIALS_DIR: '/tmp/x' })).toBe(
      '/tmp/x'
    );
    expect(defaultGrantsDirectory({})).toBe(
      join(os.homedir(), '.mcp-server-tester', 'grants')
    );
  });
});
