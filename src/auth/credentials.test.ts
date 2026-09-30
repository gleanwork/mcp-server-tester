import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIOAuthResult } from './cli.js';

const login = vi.hoisted(() => ({
  tryGetAccessToken: vi.fn<() => Promise<CLIOAuthResult | null>>(),
  servers: [] as string[],
}));

const grant = vi.hoisted(() => ({
  requestToken: vi.fn(),
}));

vi.mock('./oauthFlow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthFlowModule>()),
  performClientCredentialsFlow: grant.requestToken,
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
  ClientCredentialsAuthProvider,
  StoredLoginAuthProvider,
  configuredCredentials,
  oauthStateProvider,
  resolveCredentials,
} from './credentials.js';
import type * as OAuthFlowModule from './oauthFlow.js';
import type { TokenResult } from './types.js';
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
  grant.requestToken.mockReset().mockResolvedValue({
    accessToken: 'granted',
    tokenType: 'Bearer',
    expiresIn: 3600,
  } satisfies TokenResult);
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
    expect(credentials.authType).toBe('oauth');
    expect(credentials.authProvider).toBeInstanceOf(
      ClientCredentialsAuthProvider
    );
    // The token was requested up front, so a failing grant fails early.
    expect(grant.requestToken).toHaveBeenCalledTimes(1);
    expect((await credentials.authProvider?.tokens())?.access_token).toBe(
      'granted'
    );
    // The stored login isn't consulted, so it can't override the grant.
    expect(login.tryGetAccessToken).not.toHaveBeenCalled();
  });

  it('prefers a static token over client credentials, without running the grant', async () => {
    expect(
      await configuredCredentials(
        http({
          accessToken: 'static',
          clientCredentials: { tokenEndpoint: 'https://auth.example.test/t' },
        })
      )
    ).toEqual({ authType: 'api-token' });
    expect(grant.requestToken).not.toHaveBeenCalled();
  });

  it('rejects incomplete client credentials before connecting', async () => {
    vi.stubEnv('MCP_CLIENT_ID', '');
    vi.stubEnv('MCP_CLIENT_SECRET', '');
    await expect(
      configuredCredentials(
        http({
          clientCredentials: { tokenEndpoint: 'https://auth.example.test/t' },
        })
      )
    ).rejects.toThrow('Client credentials require clientId/clientSecret');
    vi.unstubAllEnvs();
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

  it('points env tokens at the variables, not at login', async () => {
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      { ...token('env'), fromEnv: true },
      serverUrl
    );
    await expect(provider.clientInformation()).rejects.toThrow(
      'MCP_ACCESS_TOKEN'
    );
  });

  it('retries after a failed refresh read', async () => {
    tryGetAccessToken
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(token('recovered', 10 * 60_000));
    const provider = new StoredLoginAuthProvider(
      { tryGetAccessToken },
      token('expiring', 1_000),
      serverUrl
    );
    await expect(provider.tokens()).rejects.toThrow('EACCES');
    expect((await provider.tokens()).access_token).toBe('recovered');
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

describe('ClientCredentialsAuthProvider', () => {
  const config = {
    tokenEndpoint: 'https://auth.example.test/token',
    clientId: 'id',
    clientSecret: 'secret',
  };

  it('requests a new token as the current one nears expiry', async () => {
    const requestToken = vi
      .fn<() => Promise<TokenResult>>()
      .mockResolvedValueOnce({
        accessToken: 'first',
        tokenType: 'Bearer',
        expiresIn: 30,
      })
      .mockResolvedValueOnce({
        accessToken: 'second',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });
    const provider = new ClientCredentialsAuthProvider(config, requestToken);
    expect((await provider.tokens()).access_token).toBe('first');
    // 30s left is inside the refresh window.
    const [a, b] = await Promise.all([provider.tokens(), provider.tokens()]);
    expect([a.access_token, b.access_token]).toEqual(['second', 'second']);
    expect((await provider.tokens()).access_token).toBe('second');
    expect(requestToken).toHaveBeenCalledTimes(2);
  });

  it('reuses a token without an expiry', async () => {
    const requestToken = vi
      .fn<() => Promise<TokenResult>>()
      .mockResolvedValue({ accessToken: 'forever', tokenType: 'Bearer' });
    const provider = new ClientCredentialsAuthProvider(config, requestToken);
    await provider.tokens();
    await provider.tokens();
    expect(requestToken).toHaveBeenCalledTimes(1);
  });

  it('explains a rejected token', async () => {
    const provider = new ClientCredentialsAuthProvider(config, vi.fn());
    await expect(provider.clientInformation()).rejects.toThrow(
      'The server rejected the client-credentials token from https://auth.example.test/token'
    );
  });
});

describe('oauthStateProvider', () => {
  it('needs a state file', () => {
    expect(() => oauthStateProvider({ serverUrl })).toThrow(
      'OAuth configuration requires authStatePath'
    );
  });
});
