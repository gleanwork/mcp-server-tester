/**
 * Which credentials a server config uses, decided in one place.
 *
 * Precedence for HTTP servers:
 * 1. An auth provider the caller passes in.
 * 2. `auth.oauth.authStatePath`: the Playwright OAuth state file.
 * 3. `auth.accessToken`: a static bearer token.
 * 4. `auth.clientCredentials`: a token fetched at connect.
 * 5. Otherwise, a `mcp-server-tester login` for the server (or tokens in
 *    `MCP_ACCESS_TOKEN`), through a provider that refreshes as tokens expire.
 *
 * Stdio servers take no credentials here.
 */
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import {
  isHttpConfig,
  type MCPConfig,
  type MCPOAuthConfig,
} from '../config/mcpConfig.js';
import type { AuthType } from '../types/index.js';
import { PlaywrightOAuthClientProvider } from './oauthClientProvider.js';
import { CLIOAuthClient, type CLIOAuthResult } from './cli.js';
import { TESTER_CLIENT_NAME } from './oauthFlow.js';

export interface ResolvedCredentials {
  /** How the connection authenticates, for reports. */
  authType: AuthType;
  /** Present when a provider supplies (and may refresh) the token. */
  authProvider?: OAuthClientProvider;
}

/** Refresh this long before a stored login's token expires. */
const EXPIRY_BUFFER_MS = 60_000;

/**
 * A stored `mcp-server-tester login` as an auth provider. The SDK asks for
 * `tokens()` before each request, so a token that expires during a long run
 * is refreshed from the stored refresh token instead of failing mid-run.
 * It can't start an interactive login: when refreshing fails, requests fail
 * with a message to log in again.
 */
export class StoredLoginAuthProvider implements OAuthClientProvider {
  private current: CLIOAuthResult;
  private pending: Promise<CLIOAuthResult | null> | undefined;

  constructor(
    private readonly login: Pick<CLIOAuthClient, 'tryGetAccessToken'>,
    initial: CLIOAuthResult,
    private readonly serverUrl: string
  ) {
    this.current = initial;
  }

  get redirectUrl(): string {
    return 'http://localhost/stored-login';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['refresh_token'],
      response_types: [],
      client_name: TESTER_CLIENT_NAME,
    };
  }

  /**
   * Only reached when the server rejects a token this provider considered
   * fresh (the SDK then starts its own OAuth recovery). A stored login can't
   * recover interactively, so say how to fix it.
   */
  async clientInformation(): Promise<undefined> {
    throw new Error(
      `The server rejected the stored login for ${this.serverUrl}. Run \`mcp-server-tester login ${this.serverUrl}\` again.`
    );
  }

  private isFresh(result: CLIOAuthResult): boolean {
    return (
      result.expiresAt === undefined ||
      result.expiresAt - EXPIRY_BUFFER_MS > Date.now()
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (!this.isFresh(this.current)) {
      // Concurrent requests share one refresh.
      this.pending ??= this.login.tryGetAccessToken().finally(() => {
        this.pending = undefined;
      });
      const refreshed = await this.pending;
      if (refreshed) this.current = refreshed;
    }
    return { access_token: this.current.accessToken, token_type: 'Bearer' };
  }

  async saveTokens(): Promise<void> {
    // The stored login persists its own refreshed tokens.
  }

  async redirectToAuthorization(): Promise<void> {
    throw new Error(
      `The stored login for ${this.serverUrl} expired and could not be refreshed. Run \`mcp-server-tester login ${this.serverUrl}\` again.`
    );
  }

  async saveCodeVerifier(): Promise<void> {
    // Interactive login is the CLI's job; nothing to store here.
  }

  async codeVerifier(): Promise<string> {
    throw new Error('A stored login cannot start an authorization flow.');
  }
}

/**
 * The provider for a Playwright OAuth state file (`auth.oauth.authStatePath`),
 * written by `performOAuthSetup()`.
 */
export function oauthStateProvider(
  oauth: MCPOAuthConfig
): PlaywrightOAuthClientProvider {
  if (!oauth.authStatePath)
    throw new Error(
      'OAuth configuration requires authStatePath. ' +
        'Use performOAuthSetup() in globalSetup to create auth state first.'
    );
  return new PlaywrightOAuthClientProvider({
    storagePath: oauth.authStatePath,
    redirectUri: oauth.redirectUri ?? 'http://localhost:3000/oauth/callback',
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
  });
}

/**
 * Decides which credentials a server config uses (see the module comment for
 * the precedence). Looking up a stored login reads and may refresh its tokens.
 */
export async function resolveCredentials(
  config: MCPConfig,
  options: { authProvider?: OAuthClientProvider } = {}
): Promise<ResolvedCredentials> {
  if (options.authProvider)
    return { authType: 'oauth', authProvider: options.authProvider };
  if (!isHttpConfig(config)) return { authType: 'none' };

  const auth = config.auth;
  if (auth?.oauth?.authStatePath)
    return { authType: 'oauth', authProvider: oauthStateProvider(auth.oauth) };
  if (auth?.accessToken) return { authType: 'api-token' };
  if (auth?.clientCredentials) return { authType: 'oauth' };

  const login = new CLIOAuthClient({ mcpServerUrl: config.serverUrl });
  const initial = await login.tryGetAccessToken();
  if (!initial) return { authType: 'none' };
  return {
    authType: 'oauth',
    authProvider: new StoredLoginAuthProvider(login, initial, config.serverUrl),
  };
}
