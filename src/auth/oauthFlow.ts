/**
 * OAuth flow utilities using oauth4webapi
 *
 * Implements OAuth 2.1 with PKCE as required by MCP specification
 */

import * as oauth from 'oauth4webapi';
import createDebug from 'debug';
import type { TokenResult } from './types.js';

const debug = createDebug('mcp-server-tester:oauth-flow');

/**
 * Discovered OAuth authorization server metadata
 */
export interface AuthServerMetadata {
  /**
   * The oauth4webapi AuthorizationServer object
   */
  server: oauth.AuthorizationServer;

  /**
   * Issuer URL
   */
  issuer: string;
}

/**
 * PKCE code verifier and challenge pair
 */
export interface PKCEPair {
  /**
   * Random code verifier string
   */
  codeVerifier: string;

  /**
   * S256 hashed code challenge
   */
  codeChallenge: string;
}

/**
 * Configuration for building authorization URL
 */
export interface AuthorizationUrlConfig {
  /**
   * Authorization server metadata
   */
  authServer: AuthServerMetadata;

  /**
   * Client ID
   */
  clientId: string;

  /**
   * Redirect URI for callback
   */
  redirectUri: string;

  /**
   * Requested scopes
   */
  scopes: Array<string>;

  /**
   * PKCE code challenge
   */
  codeChallenge: string;

  /**
   * OAuth state parameter for CSRF protection
   */
  state: string;

  /**
   * Resource indicator (RFC 8707)
   */
  resource?: string;
}

/**
 * Configuration for token exchange
 */
export interface TokenExchangeConfig {
  /**
   * Authorization server metadata
   */
  authServer: AuthServerMetadata;

  /**
   * Client ID
   */
  clientId: string;

  /**
   * Client secret (for confidential clients)
   */
  clientSecret?: string;

  /**
   * Authorization code from callback
   */
  code: string;

  /**
   * OAuth state parameter for CSRF validation
   */
  state: string;

  /**
   * PKCE code verifier
   */
  codeVerifier: string;

  /**
   * Redirect URI used in authorization request
   */
  redirectUri: string;
}

/**
 * Configuration for token refresh
 */
export interface TokenRefreshConfig {
  /**
   * Authorization server metadata
   */
  authServer: AuthServerMetadata;

  /**
   * Client ID
   */
  clientId: string;

  /**
   * Client secret (for confidential clients)
   */
  clientSecret?: string;

  /**
   * Refresh token
   */
  refreshToken: string;
}

/**
 * Discovers OAuth authorization server metadata from a well-known URL
 *
 * @param issuerUrl - The authorization server URL (will append /.well-known/oauth-authorization-server)
 * @returns Authorization server metadata
 */
export async function discoverAuthServer(
  issuerUrl: string
): Promise<AuthServerMetadata> {
  const issuer = new URL(issuerUrl);
  const response = await oauth.discoveryRequest(issuer, {
    algorithm: 'oauth2',
  });

  const metadata = await oauth.processDiscoveryResponse(issuer, response);

  return {
    server: metadata,
    issuer: issuerUrl,
  };
}

/**
 * Generates a PKCE code verifier and challenge pair
 *
 * Uses S256 challenge method as required by OAuth 2.1 and MCP specification
 *
 * @returns PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<PKCEPair> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  return {
    codeVerifier,
    codeChallenge,
  };
}

/**
 * Generates a random state parameter for CSRF protection
 *
 * @returns Random state string
 */
export function generateState(): string {
  return oauth.generateRandomState();
}

/**
 * Builds the OAuth authorization URL for browser redirect
 *
 * @param config - Authorization URL configuration
 * @returns Authorization URL to redirect the user to
 */
export function buildAuthorizationUrl(config: AuthorizationUrlConfig): URL {
  const authorizationEndpoint = config.authServer.server.authorization_endpoint;
  if (!authorizationEndpoint) {
    throw new Error(
      'Authorization server does not have an authorization_endpoint'
    );
  }

  const authorizationUrl = new URL(authorizationEndpoint);

  authorizationUrl.searchParams.set('client_id', config.clientId);
  authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', config.scopes.join(' '));
  authorizationUrl.searchParams.set('code_challenge', config.codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', config.state);

  if (config.resource) {
    authorizationUrl.searchParams.set('resource', config.resource);
  }

  return authorizationUrl;
}

/**
 * Exchanges an authorization code for tokens
 *
 * @param config - Token exchange configuration
 * @returns Token result
 */
export async function exchangeCodeForTokens(
  config: TokenExchangeConfig
): Promise<TokenResult> {
  const client: oauth.Client = {
    client_id: config.clientId,
    token_endpoint_auth_method: config.clientSecret
      ? 'client_secret_basic'
      : 'none',
  };

  const clientAuth = config.clientSecret
    ? oauth.ClientSecretBasic(config.clientSecret)
    : oauth.None();

  // Build callback URL with code and state for validation
  const callbackUrl = new URL(config.redirectUri);
  callbackUrl.searchParams.set('code', config.code);
  callbackUrl.searchParams.set('state', config.state);

  // Validate the auth response - oauth4webapi requires this before token exchange
  // This throws on error, returns URLSearchParams on success
  const validatedParams = oauth.validateAuthResponse(
    config.authServer.server,
    client,
    callbackUrl,
    config.state
  );

  const response = await oauth.authorizationCodeGrantRequest(
    config.authServer.server,
    client,
    clientAuth,
    validatedParams,
    config.redirectUri,
    config.codeVerifier
  );

  const result = await oauth.processAuthorizationCodeResponse(
    config.authServer.server,
    client,
    response
  );

  return {
    accessToken: result.access_token,
    tokenType: result.token_type,
    expiresIn: result.expires_in,
    refreshToken: result.refresh_token,
    scope: result.scope,
  };
}

/**
 * Refreshes an access token using a refresh token
 *
 * @param config - Token refresh configuration
 * @returns New token result
 */
export async function refreshAccessToken(
  config: TokenRefreshConfig
): Promise<TokenResult> {
  const client: oauth.Client = {
    client_id: config.clientId,
    token_endpoint_auth_method: config.clientSecret
      ? 'client_secret_basic'
      : 'none',
  };

  const clientAuth = config.clientSecret
    ? oauth.ClientSecretBasic(config.clientSecret)
    : oauth.None();

  const response = await oauth.refreshTokenGrantRequest(
    config.authServer.server,
    client,
    clientAuth,
    config.refreshToken
  );

  // Handle non-OK responses that may not be JSON (oauth4webapi requires application/json)
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    let errorMessage = `Token refresh failed: ${response.status} ${response.statusText}`;

    try {
      if (contentType.includes('application/json')) {
        // Try to extract OAuth error from JSON response
        const errorBody = (await response.clone().json()) as {
          error?: string;
          error_description?: string;
        };
        if (errorBody.error) {
          errorMessage = `Token refresh failed: ${errorBody.error}`;
          if (errorBody.error_description) {
            errorMessage += ` - ${errorBody.error_description}`;
          }
        }
      } else {
        // Non-JSON response (e.g., text/plain) - read the body as text
        const textBody = await response.clone().text();
        if (textBody) {
          errorMessage = `Token refresh failed: ${response.status} - ${textBody}`;
        }
      }
    } catch {
      // If we can't parse the error body, use the status message
    }

    throw new Error(errorMessage);
  }

  const result = await oauth.processRefreshTokenResponse(
    config.authServer.server,
    client,
    response
  );

  return {
    accessToken: result.access_token,
    tokenType: result.token_type,
    expiresIn: result.expires_in,
    refreshToken: result.refresh_token,
    scope: result.scope,
  };
}

/**
 * Configuration for client credentials grant
 */
export interface ClientCredentialsConfig {
  /**
   * Token endpoint URL
   */
  tokenEndpoint: string;

  /**
   * OAuth client ID
   */
  clientId: string;

  /**
   * OAuth client secret
   */
  clientSecret: string;

  /**
   * Scopes to request (optional)
   */
  scopes?: string[];
}

/**
 * Performs the OAuth 2.1 client credentials grant to obtain an access token.
 * Suitable for CI/CD machine-to-machine authentication.
 *
 * Uses oauth4webapi for spec-compliant request construction and response validation,
 * consistent with how the rest of this module handles OAuth flows.
 *
 * @param config - Client credentials configuration
 * @returns Token result
 */
export async function performClientCredentialsFlow(
  config: ClientCredentialsConfig
): Promise<TokenResult> {
  // Construct minimal AuthorizationServer from the token endpoint URL.
  // oauth4webapi requires an issuer; we use the origin of the token endpoint.
  const tokenEndpointUrl = new URL(config.tokenEndpoint);
  const authServer: oauth.AuthorizationServer = {
    issuer: tokenEndpointUrl.origin,
    token_endpoint: config.tokenEndpoint,
  };

  const client: oauth.Client = {
    client_id: config.clientId,
  };

  // ClientSecretBasic transmits credentials via Authorization: Basic header (RFC 6749 §2.3.1).
  // This is the recommended method — avoids placing secrets in the request body.
  const clientAuth = oauth.ClientSecretBasic(config.clientSecret);

  const parameters: Record<string, string> = {};
  if (config.scopes && config.scopes.length > 0) {
    parameters['scope'] = config.scopes.join(' ');
  }

  const response = await oauth.clientCredentialsGrantRequest(
    authServer,
    client,
    clientAuth,
    parameters
  );

  const result = await oauth.processClientCredentialsResponse(
    authServer,
    client,
    response
  );

  const requestedScopes = new Set(
    config.scopes && config.scopes.length > 0 ? config.scopes : []
  );
  const grantedScopes = new Set(
    (result.scope ?? '').split(' ').filter(Boolean)
  );
  const missingScopes = [...requestedScopes].filter(
    (s) => !grantedScopes.has(s)
  );
  if (
    missingScopes.length > 0 &&
    requestedScopes.size > 0 &&
    grantedScopes.size > 0
  ) {
    debug(
      '[oauth] Warning: Token server granted fewer scopes than requested. Missing: %s',
      missingScopes.join(', ')
    );
  }

  return {
    accessToken: result.access_token,
    tokenType: result.token_type,
    expiresIn: result.expires_in,
    scope: result.scope,
  };
}

/**
 * Validates the callback URL from OAuth redirect
 *
 * @param callbackUrl - The full callback URL with query parameters
 * @param expectedState - The state parameter sent in the authorization request
 * @returns The authorization code
 * @throws Error if validation fails
 */
export function validateCallback(
  callbackUrl: URL,
  expectedState: string
): string {
  const error = callbackUrl.searchParams.get('error');
  if (error) {
    const errorDescription = callbackUrl.searchParams.get('error_description');
    throw new Error(
      `OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`
    );
  }

  const state = callbackUrl.searchParams.get('state');
  if (state !== expectedState) {
    throw new Error('OAuth state mismatch - possible CSRF attack');
  }

  const code = callbackUrl.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code in callback URL');
  }

  return code;
}
