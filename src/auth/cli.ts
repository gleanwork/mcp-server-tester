/**
 * CLI OAuth client for command-line authentication flows
 *
 * Provides browser-based OAuth authentication for CLI environments,
 * with support for environment variable token injection for CI/CD.
 */

import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import createDebug from 'debug';
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type AuthServerMetadata,
} from './oauthFlow.js';
import {
  discoverProtectedResource,
  discoverAuthorizationServer,
  MCP_PROTOCOL_VERSION,
  type ProtectedResourceMetadata,
} from './discovery.js';
import {
  createFileOAuthStorage,
  loadTokensFromEnv,
  type OAuthStorage,
  type StoredServerMetadata,
} from './storage.js';
import type { StoredTokens, StoredClientInfo, TokenResult } from './types.js';

const debug = createDebug('mcp-server-tester:cli-oauth');

/**
 * Configuration for CLI OAuth client
 */
export interface CLIOAuthClientConfig {
  /**
   * MCP server URL (for protected resource discovery)
   */
  mcpServerUrl: string;

  /**
   * Scopes to request (optional, uses discovered scopes if not provided)
   */
  scopes?: Array<string>;

  /**
   * Custom storage directory
   */
  stateDir?: string;

  /**
   * Pre-registered client ID (skips DCR if provided)
   */
  clientId?: string;

  /**
   * Pre-registered client secret
   */
  clientSecret?: string;

  /**
   * Preferred callback port (default: random available port)
   */
  callbackPort?: number;

  /**
   * Timeout for OAuth flow in milliseconds (default: 300000 = 5 min)
   */
  timeoutMs?: number;

  /**
   * Client name for DCR registration
   */
  clientName?: string;
}

/**
 * Result of CLI OAuth authentication
 */
export interface CLIOAuthResult {
  /**
   * Access token
   */
  accessToken: string;

  /**
   * Token type (typically "Bearer")
   */
  tokenType: string;

  /**
   * Expiration timestamp (Unix ms)
   */
  expiresAt?: number;

  /**
   * Whether token was refreshed vs newly acquired
   */
  refreshed: boolean;

  /**
   * Scopes that were requested (only set for new authentications)
   */
  requestedScopes?: string[];

  /**
   * Whether token came from environment variables
   */
  fromEnv: boolean;
}

/**
 * Default timeout for OAuth flow (5 minutes)
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Default client name for DCR
 */
const DEFAULT_CLIENT_NAME = '@gleanwork/mcp-server-tester';

/**
 * Default TTL for cached server metadata (24 hours)
 * After this time, metadata will be re-discovered
 */
const DEFAULT_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * CLI OAuth client for command-line authentication flows
 */
export class CLIOAuthClient {
  private readonly config: CLIOAuthClientConfig;
  private readonly storage: OAuthStorage;

  constructor(config: CLIOAuthClientConfig) {
    this.config = config;
    this.storage = createFileOAuthStorage({
      serverUrl: config.mcpServerUrl,
      stateDir: config.stateDir,
    });
  }

  /**
   * Get a valid access token, authenticating if necessary
   *
   * Token resolution priority:
   * 1. Check environment variables (for CI/CD)
   * 2. Check file storage for cached tokens
   * 3. Try to refresh if expired but refresh token exists
   * 4. Run full OAuth flow if needed
   */
  async getAccessToken(): Promise<CLIOAuthResult> {
    // 1. Check environment variables first (CI/CD support)
    const envTokens = loadTokensFromEnv();
    if (envTokens) {
      debug('Using tokens from environment variables');
      return {
        accessToken: envTokens.accessToken,
        tokenType: envTokens.tokenType,
        expiresAt: envTokens.expiresAt,
        refreshed: false,
        fromEnv: true,
      };
    }

    // 2. Check file storage for cached tokens
    const storedTokens = await this.storage.loadTokens();

    if (storedTokens?.accessToken) {
      // Check if token is still valid
      const isValid = await this.storage.hasValidToken();

      if (isValid) {
        debug('Using cached tokens from storage');
        return {
          accessToken: storedTokens.accessToken,
          tokenType: storedTokens.tokenType,
          expiresAt: storedTokens.expiresAt,
          refreshed: false,
          fromEnv: false,
        };
      }

      // 3. Try to refresh if we have a refresh token
      if (storedTokens.refreshToken) {
        debug('Token expired, attempting refresh');
        try {
          const refreshedTokens = await this.refreshStoredToken(storedTokens);
          return {
            accessToken: refreshedTokens.accessToken,
            tokenType: refreshedTokens.tokenType,
            expiresAt: refreshedTokens.expiresAt,
            refreshed: true,
            fromEnv: false,
          };
        } catch (error) {
          debug('Token refresh failed, will re-authenticate:', error);
          // Fall through to full authentication
        }
      }
    }

    // 4. Run full OAuth flow
    debug('Performing full OAuth authentication');
    return this.authenticate();
  }

  /**
   * Try to get a valid access token without triggering browser auth
   *
   * Returns null if no valid token is available (no stored tokens,
   * expired without refresh token, or refresh failed). Unlike getAccessToken(),
   * this will NOT open a browser for authentication.
   *
   * Use this for CLI commands that should prompt the user to run `login`
   * instead of automatically starting the OAuth flow.
   */
  async tryGetAccessToken(): Promise<CLIOAuthResult | null> {
    // 1. Check environment variables first (CI/CD support)
    const envTokens = loadTokensFromEnv();
    if (envTokens) {
      debug('Using tokens from environment variables');
      return {
        accessToken: envTokens.accessToken,
        tokenType: envTokens.tokenType,
        expiresAt: envTokens.expiresAt,
        refreshed: false,
        fromEnv: true,
      };
    }

    // 2. Check file storage for cached tokens
    const storedTokens = await this.storage.loadTokens();

    if (storedTokens?.accessToken) {
      // Check if token is still valid
      const isValid = await this.storage.hasValidToken();

      if (isValid) {
        debug('Using cached tokens from storage');
        return {
          accessToken: storedTokens.accessToken,
          tokenType: storedTokens.tokenType,
          expiresAt: storedTokens.expiresAt,
          refreshed: false,
          fromEnv: false,
        };
      }

      // 3. Try to refresh if we have a refresh token
      if (storedTokens.refreshToken) {
        debug('Token expired, attempting refresh');
        try {
          const refreshedTokens = await this.refreshStoredToken(storedTokens);
          return {
            accessToken: refreshedTokens.accessToken,
            tokenType: refreshedTokens.tokenType,
            expiresAt: refreshedTokens.expiresAt,
            refreshed: true,
            fromEnv: false,
          };
        } catch (error) {
          debug('Token refresh failed:', error);
          // Return null - don't fall through to browser auth
          return null;
        }
      }
    }

    // No valid token available - return null instead of opening browser
    debug('No valid token available');
    return null;
  }

  /**
   * Force a new authentication flow
   */
  async authenticate(): Promise<CLIOAuthResult> {
    // Discover servers
    const { protectedResource, authServer } = await this.discoverServers();

    // Get or register client
    const client = await this.getOrRegisterClient(authServer);

    // Perform OAuth flow
    const { tokens, requestedScopes } = await this.performOAuthFlow(
      authServer,
      client,
      protectedResource
    );

    return {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      refreshed: false,
      fromEnv: false,
      requestedScopes,
    };
  }

  /**
   * Check if stored credentials exist (may be expired)
   */
  async hasStoredCredentials(): Promise<boolean> {
    const tokens = await this.storage.loadTokens();
    return tokens?.accessToken !== undefined;
  }

  /**
   * Clear stored credentials
   */
  async clearCredentials(): Promise<void> {
    await this.storage.deleteTokens();
    debug('Cleared stored credentials');
  }

  /**
   * Discover protected resource and authorization server
   */
  private async discoverServers(): Promise<{
    protectedResource: ProtectedResourceMetadata;
    authServer: AuthServerMetadata;
  }> {
    // Check cached server metadata
    const cachedMetadata = await this.storage.loadServerMetadata();
    if (cachedMetadata) {
      // Check if metadata is stale (older than TTL)
      const age = Date.now() - cachedMetadata.discoveredAt;
      if (age < DEFAULT_METADATA_TTL_MS) {
        debug('Using cached server metadata (age: %dms)', age);
        debug(
          'Cached protected resource scopes: %O',
          cachedMetadata.protectedResource.scopes_supported
        );
        debug(
          'Cached auth server scopes: %O',
          cachedMetadata.authServer.server.scopes_supported
        );
        return {
          protectedResource: cachedMetadata.protectedResource,
          authServer: cachedMetadata.authServer,
        };
      }
      debug('Cached server metadata is stale (age: %dms), re-discovering', age);
    }

    // Discover protected resource
    debug('Discovering protected resource:', this.config.mcpServerUrl);
    const prResult = await discoverProtectedResource(this.config.mcpServerUrl);
    debug('Found protected resource:', prResult.metadata.resource);
    debug(
      'Protected resource scopes_supported: %O',
      prResult.metadata.scopes_supported
    );

    // Get authorization server URL
    const authServerUrl = prResult.metadata.authorization_servers?.[0];
    if (!authServerUrl) {
      throw new Error(
        'No authorization servers found in protected resource metadata'
      );
    }

    // Discover authorization server
    debug('Discovering authorization server:', authServerUrl);
    const authServer = await discoverAuthorizationServer(authServerUrl);
    debug('Found authorization server:', authServer.issuer);
    debug(
      'Auth server scopes_supported: %O',
      authServer.server.scopes_supported
    );

    // Cache metadata
    const metadata: StoredServerMetadata = {
      authServer,
      protectedResource: prResult.metadata,
      discoveredAt: Date.now(),
    };
    await this.storage.saveServerMetadata(metadata);

    return {
      protectedResource: prResult.metadata,
      authServer,
    };
  }

  /**
   * Get existing client or register new one via DCR
   */
  private async getOrRegisterClient(
    authServer: AuthServerMetadata
  ): Promise<StoredClientInfo> {
    // Use pre-configured client if provided
    if (this.config.clientId) {
      debug('Using pre-configured client ID');
      return {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      };
    }

    // Check cached client
    const cachedClient = await this.storage.loadClient();
    if (cachedClient?.clientId) {
      debug('Using cached client registration');
      return cachedClient;
    }

    // Register new client via DCR
    debug('Registering new client via DCR');
    const client = await this.registerClient(authServer);
    await this.storage.saveClient(client);

    return client;
  }

  /**
   * Register a new client via Dynamic Client Registration
   */
  private async registerClient(
    authServer: AuthServerMetadata
  ): Promise<StoredClientInfo> {
    const registrationEndpoint = authServer.server.registration_endpoint;
    if (!registrationEndpoint) {
      throw new Error(
        'Authorization server does not support Dynamic Client Registration. ' +
          'Please provide a clientId in the configuration.'
      );
    }

    // We'll use a placeholder redirect URI for now
    // The actual port will be determined when we start the callback server
    const redirectUri = 'http://127.0.0.1:0/callback';

    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: this.config.clientName ?? DEFAULT_CLIENT_NAME,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Dynamic Client Registration failed: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    const data = (await response.json()) as {
      client_id: string;
      client_secret?: string;
      client_id_issued_at?: number;
      client_secret_expires_at?: number;
    };

    debug('Client registered:', data.client_id);

    return {
      clientId: data.client_id,
      clientSecret: data.client_secret,
      clientIdIssuedAt: data.client_id_issued_at,
      clientSecretExpiresAt: data.client_secret_expires_at,
    };
  }

  /**
   * Perform the full OAuth authorization flow
   */
  private async performOAuthFlow(
    authServer: AuthServerMetadata,
    client: StoredClientInfo,
    protectedResource: ProtectedResourceMetadata
  ): Promise<{ tokens: StoredTokens; requestedScopes: string[] }> {
    // Generate PKCE and state
    const pkce = await generatePKCE();
    const state = generateState();

    // Start callback server
    const { port, codePromise, close } = await this.startCallbackServer(state);
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    try {
      // Determine scopes: user-provided > protected resource > auth server > fallback
      // Try multiple sources since not all servers advertise scopes in the same place
      const requestedScopes = this.config.scopes ??
        protectedResource.scopes_supported ??
        authServer.server.scopes_supported ?? ['openid'];

      debug('Scope resolution:');
      debug('  - User config scopes: %O', this.config.scopes);
      debug(
        '  - Protected resource scopes_supported: %O',
        protectedResource.scopes_supported
      );
      debug(
        '  - Auth server scopes_supported: %O',
        authServer.server.scopes_supported
      );
      debug('  - Final requested scopes: %O', requestedScopes);

      const authUrl = buildAuthorizationUrl({
        authServer,
        clientId: client.clientId,
        redirectUri,
        scopes: requestedScopes,
        codeChallenge: pkce.codeChallenge,
        state,
        resource: protectedResource.resource,
      });

      // Log only non-sensitive parts of the authorization URL.
      // Do NOT log: state, code_challenge, code_challenge_method (security-sensitive).
      debug(
        'Authorization URL (base): %s',
        `${authUrl.origin}${authUrl.pathname}`
      );
      debug('Authorization URL params:');
      debug('  - client_id: %s', authUrl.searchParams.get('client_id'));
      debug('  - redirect_uri: %s', authUrl.searchParams.get('redirect_uri'));
      debug('  - scope: %s', authUrl.searchParams.get('scope'));
      debug('  - resource: %s', authUrl.searchParams.get('resource'));

      // Open browser or print URL
      await this.openBrowserOrPrintUrl(authUrl);

      // Wait for callback
      debug('Waiting for OAuth callback...');
      const code = await codePromise;
      debug('Received authorization code');

      // Exchange code for tokens
      const tokenResult = await exchangeCodeForTokens({
        authServer,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        state,
        codeVerifier: pkce.codeVerifier,
        redirectUri,
      });

      // Store tokens with the client ID used to obtain them
      const tokens = this.tokenResultToStoredTokens(
        tokenResult,
        client.clientId
      );
      await this.storage.saveTokens(tokens);

      return { tokens, requestedScopes };
    } finally {
      // Clean up callback server and all connections
      close();
    }
  }

  /**
   * Refresh an expired token
   *
   * Uses the clientId stored with the tokens (if available) to ensure
   * the refresh request uses the same client that obtained the original tokens.
   * This is important because refresh tokens are bound to the client_id.
   */
  private async refreshStoredToken(
    storedTokens: StoredTokens
  ): Promise<StoredTokens> {
    if (!storedTokens.refreshToken) {
      throw new Error('No refresh token available');
    }

    // Get cached server metadata
    const metadata = await this.storage.loadServerMetadata();
    if (!metadata) {
      throw new Error('No cached server metadata for refresh');
    }

    // Determine which client credentials to use for refresh.
    // Priority: tokens.clientId > stored client.json > error
    let clientId: string;
    let clientSecret: string | undefined;

    if (storedTokens.clientId) {
      // Use the client ID that was used to obtain these tokens
      debug('Using clientId from stored tokens for refresh');
      clientId = storedTokens.clientId;

      // Try to get the client secret from stored client info if it matches
      const storedClient = await this.storage.loadClient();
      if (storedClient?.clientId === clientId) {
        clientSecret = storedClient.clientSecret;
      }
    } else {
      // Legacy tokens without clientId - fall back to stored client
      debug(
        'No clientId in stored tokens, falling back to stored client (legacy behavior)'
      );
      const client = await this.getOrRegisterClient(metadata.authServer);
      clientId = client.clientId;
      clientSecret = client.clientSecret;
    }

    // Refresh token
    const tokenResult = await refreshAccessToken({
      authServer: metadata.authServer,
      clientId,
      clientSecret,
      refreshToken: storedTokens.refreshToken,
    });

    // Store new tokens with the clientId that was used
    const tokens = this.tokenResultToStoredTokens(tokenResult, clientId);
    await this.storage.saveTokens(tokens);

    return tokens;
  }

  /**
   * Start local callback server
   */
  private async startCallbackServer(expectedState: string): Promise<{
    port: number;
    codePromise: Promise<string>;
    close: () => void;
  }> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const server = http.createServer();

      // Track active connections so we can force-close them
      const connections = new Set<Socket>();
      server.on('connection', (socket) => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
      });

      // Helper to force-close the server
      const forceClose = () => {
        for (const socket of connections) {
          socket.destroy();
        }
        server.close();
      };

      let codeResolve: (code: string) => void;
      let codeReject: (error: Error) => void;

      const codePromise = new Promise<string>((res, rej) => {
        codeResolve = res;
        codeReject = rej;
      });

      // Set up timeout
      const timeout = setTimeout(() => {
        forceClose();
        codeReject(new Error(`OAuth flow timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Handle incoming requests
      server.on('request', (req, res) => {
        const url = new URL(
          req.url ?? '/',
          `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        );

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        // Check for errors
        const error = url.searchParams.get('error');
        if (error) {
          const errorDescription = url.searchParams.get('error_description');
          clearTimeout(timeout);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this.errorHtml(error, errorDescription ?? undefined));
          codeReject(
            new Error(
              `OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`
            )
          );
          return;
        }

        // Validate state
        const state = url.searchParams.get('state');
        if (state !== expectedState) {
          clearTimeout(timeout);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this.errorHtml('invalid_state', 'State parameter mismatch'));
          codeReject(new Error('OAuth state mismatch - possible CSRF attack'));
          return;
        }

        // Get authorization code
        const code = url.searchParams.get('code');
        if (!code) {
          clearTimeout(timeout);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            this.errorHtml('missing_code', 'No authorization code received')
          );
          codeReject(new Error('No authorization code in callback'));
          return;
        }

        // Success!
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.successHtml());
        codeResolve(code);
      });

      // Listen on preferred port or random port
      const preferredPort = this.config.callbackPort ?? 0;

      server.listen(preferredPort, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        debug('Callback server listening on port', address.port);
        resolve({ port: address.port, codePromise, close: forceClose });
      });

      server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Open browser or print URL for headless environments
   */
  private async openBrowserOrPrintUrl(url: URL): Promise<void> {
    if (isHeadless()) {
      console.log('\n' + '='.repeat(60));
      console.log(
        'Please open the following URL in your browser to authenticate:'
      );
      console.log('\n' + url.toString() + '\n');
      console.log('='.repeat(60) + '\n');
      return;
    }

    try {
      // Dynamic import of 'open' package
      const open = await import('open');
      await open.default(url.toString());
      debug('Opened browser for authentication');
    } catch (error) {
      // If browser opening fails, fall back to printing URL
      debug('Failed to open browser:', error);
      console.log('\nFailed to open browser automatically.');
      console.log('Please open the following URL manually:\n');
      console.log(url.toString() + '\n');
    }
  }

  /**
   * Convert TokenResult to StoredTokens
   *
   * @param result - Token result from exchange or refresh
   * @param clientId - Client ID that was used to obtain these tokens
   */
  private tokenResultToStoredTokens(
    result: TokenResult,
    clientId: string
  ): StoredTokens {
    return {
      accessToken: result.accessToken,
      tokenType: result.tokenType,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresIn
        ? Date.now() + result.expiresIn * 1000
        : undefined,
      clientId,
    };
  }

  /**
   * HTML page for successful authentication
   */
  private successHtml(): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
           background: #f8fafc; }
    .container { text-align: center; background: white; padding: 48px 64px; border-radius: 8px;
                 border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .icon { width: 48px; height: 48px; margin: 0 auto 24px; background: #dcfce7; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; }
    .icon svg { width: 24px; height: 24px; color: #16a34a; }
    h1 { color: #0f172a; margin: 0 0 8px 0; font-size: 20px; font-weight: 600; }
    p { color: #64748b; margin: 0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;
  }

  /**
   * HTML page for authentication error
   */
  private errorHtml(error: string, description?: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Authentication Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
           background: #f8fafc; }
    .container { text-align: center; background: white; padding: 48px 64px; border-radius: 8px;
                 border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .icon { width: 48px; height: 48px; margin: 0 auto 24px; background: #fee2e2; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; }
    .icon svg { width: 24px; height: 24px; color: #dc2626; }
    h1 { color: #0f172a; margin: 0 0 8px 0; font-size: 20px; font-weight: 600; }
    p { color: #64748b; margin: 0 0 8px 0; font-size: 14px; }
    code { background: #f1f5f9; padding: 2px 8px; border-radius: 4px; color: #dc2626; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </div>
    <h1>Authentication Failed</h1>
    <p>Error: <code>${escapeHtml(error)}</code></p>
    ${description ? `<p>${escapeHtml(description)}</p>` : ''}
  </div>
</body>
</html>`;
  }
}

/**
 * Detect if running in a headless environment
 */
function isHeadless(): boolean {
  // CI environment
  if (process.env.CI) {
    return true;
  }

  // No TTY (piped input)
  if (!process.stdin.isTTY) {
    return true;
  }

  // Linux without DISPLAY (no X server)
  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return true;
  }

  return false;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
