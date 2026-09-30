import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOAuthResult } from './cli.js';

const login = vi.hoisted(() => ({
  tryGetAccessToken: vi.fn<() => Promise<CLIOAuthResult | null>>(),
  servers: [] as string[],
}));

vi.mock('./cli.js', () => ({
  CLIOAuthClient: class {
    constructor(config: { mcpServerUrl: string }) {
      login.servers.push(config.mcpServerUrl);
    }
    tryGetAccessToken = login.tryGetAccessToken;
  },
}));

import {
  StoredLoginAuthProvider,
  oauthStateProvider,
  resolveCredentials,
} from './credentials.js';
import { PlaywrightOAuthClientProvider } from './oauthClientProvider.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';

const serverUrl = 'https://mcp.example.test/mcp';
const http = (auth?: Record<string, unknown>): MCPConfig =>
  ({ transport: 'http', serverUrl, ...(auth ? { auth } : {}) }) as MCPConfig;

function token(accessToken: string, expiresInMs?: number): CLIOAuthResult {
  return {
    accessToken,
    tokenType: 'Bearer',
    ...(expiresInMs !== undefined
      ? { expiresAt: Date.now() + expiresInMs }
      : {}),
    refreshed: false,
    fromEnv: false,
  } as CLIOAuthResult;
}

beforeEach(() => {
  login.tryGetAccessToken.mockReset();
  login.servers.length = 0;
});

describe('resolveCredentials precedence', () => {
  it('prefers a provider the caller passes in', async () => {
    const authProvider = {} as OAuthClientProvider;
    expect(
      await resolveCredentials(http({ accessToken: 'static' }), {
        authProvider,
      })
    ).toEqual({ authType: 'oauth', authProvider });
  });

  it('uses the OAuth state file, then a static token', async () => {
    const withState = await resolveCredentials(
      http({
        oauth: { serverUrl, authStatePath: '.auth/state.json' },
        accessToken: 'static',
      })
    );
    expect(withState.authType).toBe('oauth');
    expect(withState.authProvider).toBeInstanceOf(
      PlaywrightOAuthClientProvider
    );
    expect(await resolveCredentials(http({ accessToken: 'static' }))).toEqual({
      authType: 'api-token',
    });
  });

  it('keeps configured client credentials instead of a stored login', async () => {
    login.tryGetAccessToken.mockResolvedValue(token('stored'));
    const credentials = await resolveCredentials(
      http({
        clientCredentials: {
          tokenEndpoint: 'https://auth.example.test/token',
          clientId: 'id',
          clientSecret: 'secret',
        },
      })
    );
    expect(credentials).toEqual({ authType: 'oauth' });
    // The stored login isn't consulted, so it can't override the grant.
    expect(login.tryGetAccessToken).not.toHaveBeenCalled();
  });

  it('falls back to a stored login for the server', async () => {
    login.tryGetAccessToken.mockResolvedValue(token('stored'));
    const credentials = await resolveCredentials(http());
    expect(credentials.authType).toBe('oauth');
    expect(credentials.authProvider).toBeInstanceOf(StoredLoginAuthProvider);
    expect(login.servers).toEqual([serverUrl]);
    expect(await credentials.authProvider?.tokens()).toEqual({
      access_token: 'stored',
      token_type: 'Bearer',
    });
  });

  it('uses no credentials without a login, or for stdio servers', async () => {
    login.tryGetAccessToken.mockResolvedValue(null);
    expect(await resolveCredentials(http())).toEqual({ authType: 'none' });
    expect(
      await resolveCredentials({ transport: 'stdio', command: 'server' })
    ).toEqual({ authType: 'none' });
  });
});

describe('StoredLoginAuthProvider', () => {
  const tryGetAccessToken = login.tryGetAccessToken;

  it('reuses a fresh token without reading the login again', async () => {
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      token('fresh', 10 * 60_000),
      serverUrl
    );
    await provider.tokens();
    await provider.tokens();
    expect(tryGetAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent requests as the token expires', async () => {
    let finish: (value: CLIOAuthResult) => void = () => {};
    tryGetAccessToken.mockReturnValue(
      new Promise<CLIOAuthResult>((resolve) => {
        finish = resolve;
      })
    );
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      token('expiring', 30_000),
      serverUrl
    );
    const requests = [provider.tokens(), provider.tokens(), provider.tokens()];
    finish(token('refreshed', 10 * 60_000));
    const tokens = await Promise.all(requests);
    expect(tryGetAccessToken).toHaveBeenCalledTimes(1);
    expect(tokens.map((t) => t?.access_token)).toEqual([
      'refreshed',
      'refreshed',
      'refreshed',
    ]);
    await provider.tokens();
    expect(tryGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it('keeps the last token when refreshing fails', async () => {
    tryGetAccessToken.mockResolvedValue(null);
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      token('expired', -1_000),
      serverUrl
    );
    expect((await provider.tokens())?.access_token).toBe('expired');
  });

  it('tells the user to log in again when the server rejects the login', async () => {
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      token('rejected'),
      serverUrl
    );
    const relogin = `mcp-server-tester login ${serverUrl}`;
    await expect(provider.clientInformation()).rejects.toThrow(relogin);
    await expect(provider.redirectToAuthorization()).rejects.toThrow(relogin);
  });
});

describe('oauthStateProvider', () => {
  it('needs a state file', () => {
    expect(() => oauthStateProvider({ serverUrl })).toThrow(
      'OAuth configuration requires authStatePath'
    );
  });
});
