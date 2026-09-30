/**
 * Which credentials a server config uses, decided in one place.
 *
 * Precedence for HTTP servers:
 * 1. An auth provider the caller passes in.
 * 2. `auth.oauth.authStatePath`: the Playwright OAuth state file.
 * 3. `auth.accessToken`: a static bearer token.
 * 4. `auth.clientCredentials`: a token from the client-credentials grant,
 *    fetched again as it expires.
 * 5. (Fixtures only) a `mcp-server-tester login` for the server, or tokens
 *    in `MCP_ACCESS_TOKEN`, refreshed as they expire.
 *
 * `configuredCredentials` answers 2-4 from the config alone (the client
 * factory uses it); `resolveCredentials` adds 1 and 5 (the fixtures use it).
 * Stdio servers take no credentials.
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
import {
  performClientCredentialsFlow,
  TESTER_CLIENT_NAME,
  type ClientCredentialsConfig,
} from './oauthFlow.js';
import type { TokenResult } from './types.js';

export interface ResolvedCredentials {
  /** How the connection authenticates, for reports. */
  authType: AuthType;
  /** Present when a provider supplies (and may refresh) the token. */
  authProvider?: OAuthClientProvider;
}

/** Refresh this long before a token expires. */
const EXPIRY_BUFFER_MS = 60_000;

function isFresh(expiresAt: number | undefined): boolean {
  return expiresAt === undefined || expiresAt - EXPIRY_BUFFER_MS > Date.now();
}

/**
 * A provider that only supplies bearer tokens; it can't run an OAuth flow.
 * The SDK asks for `tokens()` before each request. It only reaches the other
 * methods when the server rejects a token, and they can't help then, so they
 * explain what to do instead.
 */
export abstract class BearerTokenAuthProvider implements OAuthClientProvider {
  /** The token to send now, refreshed if the provider can. */
  protected abstract accessToken(): Promise<string>;
  /** Why a rejected token can't be recovered here, and what to do. */
  protected abstract rejectedMessage(): string;

  get redirectUrl(): string {
    return 'http://localhost/bearer-token';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
      grant_types: [],
      response_types: [],
      client_name: TESTER_CLIENT_NAME,
    };
  }

  async tokens(): Promise<OAuthTokens> {
    return { access_token: await this.accessToken(), token_type: 'Bearer' };
  }

  async clientInformation(): Promise<undefined> {
    throw new Error(this.rejectedMessage());
  }

  async saveTokens(): Promise<void> {
    // Nothing to persist: the token's source keeps its own state.
  }

  async redirectToAuthorization(): Promise<void> {
    throw new Error(this.rejectedMessage());
  }

  async saveCodeVerifier(): Promise<void> {
    // No authorization flow, so no verifier.
  }

  async codeVerifier(): Promise<string> {
    throw new Error(this.rejectedMessage());
  }
}

/**
 * A stored `mcp-server-tester login` (or `MCP_ACCESS_TOKEN` tokens). The token
 * is refreshed from the stored refresh token as it nears expiry, so a token
 * that expires during a long run doesn't fail it.
 */
export class StoredLoginAuthProvider extends BearerTokenAuthProvider {
  private current: CLIOAuthResult;
  private pending: Promise<CLIOAuthResult | null> | undefined;

  constructor(
    private readonly login: Pick<CLIOAuthClient, 'tryGetAccessToken'>,
    initial: CLIOAuthResult,
    private readonly serverUrl: string
  ) {
    super();
    this.current = initial;
  }

  protected async accessToken(): Promise<string> {
    if (!isFresh(this.current.expiresAt)) {
      // Concurrent requests share one refresh.
      this.pending ??= this.login.tryGetAccessToken().finally(() => {
        this.pending = undefined;
      });
      const refreshed = await this.pending;
      if (refreshed) this.current = refreshed;
    }
    return this.current.accessToken;
  }

  protected rejectedMessage(): string {
    return this.current.fromEnv
      ? `The server rejected the token in MCP_ACCESS_TOKEN for ${this.serverUrl}. Update it (and MCP_REFRESH_TOKEN) or unset them.`
      : `The server rejected the stored login for ${this.serverUrl}. Run \`mcp-server-tester login ${this.serverUrl}\` again.`;
  }
}

/**
 * Tokens from the client-credentials grant, requested again as they near
 * expiry, so long runs outlive the first token.
 */
export class ClientCredentialsAuthProvider extends BearerTokenAuthProvider {
  private current: { accessToken: string; expiresAt?: number } | undefined;
  private pending: Promise<TokenResult> | undefined;

  constructor(
    private readonly grant: ClientCredentialsConfig,
    private readonly requestToken: (
      config: ClientCredentialsConfig
    ) => Promise<TokenResult> = performClientCredentialsFlow
  ) {
    super();
  }

  protected async accessToken(): Promise<string> {
    if (!this.current || !isFresh(this.current.expiresAt)) {
      this.pending ??= this.requestToken(this.grant).finally(() => {
        this.pending = undefined;
      });
      const result = await this.pending;
      this.current = {
        accessToken: result.accessToken,
        ...(result.expiresIn !== undefined
          ? { expiresAt: Date.now() + result.expiresIn * 1000 }
          : {}),
      };
    }
    return this.current.accessToken;
  }

  protected rejectedMessage(): string {
    return `The server rejected the client-credentials token from ${this.grant.tokenEndpoint}. Check the client's grants and scopes.`;
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
 * The credentials a config declares (precedence 2-4 above), without looking
 * for a stored login. A client-credentials token is requested here, so a
 * misconfigured or failing grant fails before connecting.
 */
export async function configuredCredentials(
  config: MCPConfig
): Promise<ResolvedCredentials> {
  if (!isHttpConfig(config)) return { authType: 'none' };
  const auth = config.auth;
  if (auth?.oauth?.authStatePath)
    return { authType: 'oauth', authProvider: oauthStateProvider(auth.oauth) };
  if (auth?.accessToken) return { authType: 'api-token' };
  if (auth?.clientCredentials) {
    const grant = auth.clientCredentials;
    const clientId = grant.clientId ?? process.env['MCP_CLIENT_ID'];
    const clientSecret = grant.clientSecret ?? process.env['MCP_CLIENT_SECRET'];
    if (!clientId || !clientSecret)
      throw new Error(
        'Client credentials require clientId/clientSecret in config or MCP_CLIENT_ID/MCP_CLIENT_SECRET env vars'
      );
    if (!grant.tokenEndpoint)
      throw new Error(
        'Client credentials require tokenEndpoint in auth.clientCredentials config'
      );
    const authProvider = new ClientCredentialsAuthProvider({
      tokenEndpoint: grant.tokenEndpoint,
      clientId,
      clientSecret,
      scopes: grant.scopes,
    });
    await authProvider.tokens();
    return { authType: 'oauth', authProvider };
  }
  return { authType: 'none' };
}

/**
 * Decides which credentials a server config uses in a test (all of the
 * precedence above). Looking up a stored login reads and may refresh it.
 */
export async function resolveCredentials(
  config: MCPConfig,
  options: { authProvider?: OAuthClientProvider } = {}
): Promise<ResolvedCredentials> {
  if (options.authProvider)
    return { authType: 'oauth', authProvider: options.authProvider };
  const configured = await configuredCredentials(config);
  if (configured.authType !== 'none' || !isHttpConfig(config))
    return configured;

  const login = new CLIOAuthClient({ mcpServerUrl: config.serverUrl });
  const initial = await login.tryGetAccessToken();
  if (!initial) return { authType: 'none' };
  return {
    authType: 'oauth',
    authProvider: new StoredLoginAuthProvider(login, initial, config.serverUrl),
  };
}
