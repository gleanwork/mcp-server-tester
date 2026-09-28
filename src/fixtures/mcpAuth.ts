/**
 * Playwright fixtures for MCP OAuth authentication
 *
 * Provides worker-scoped OAuth authentication following Playwright's
 * recommended auth state pattern.
 */

import { test as base } from '@playwright/test';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import type { MCPAuthConfig, MCPOAuthConfig } from '../config/mcpConfig.js';
import {
  PlaywrightOAuthClientProvider,
  type PlaywrightOAuthClientProviderConfig,
} from '../auth/oauthClientProvider.js';

/**
 * Static token auth provider that wraps a pre-acquired token
 *
 * This is a minimal implementation that provides tokens directly
 * without OAuth flow support.
 */
class StaticTokenAuthProvider implements OAuthClientProvider {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  get redirectUrl(): string {
    throw new Error('StaticTokenAuthProvider does not support OAuth redirects');
  }

  get clientMetadata() {
    return {
      redirect_uris: [],
      token_endpoint_auth_method: 'none' as const,
      grant_types: [],
      response_types: [],
      client_name: '@gleanwork/mcp-server-tester',
    };
  }

  async clientInformation() {
    return undefined;
  }

  async tokens() {
    return {
      access_token: this.accessToken,
      token_type: 'Bearer',
    };
  }

  async saveTokens(): Promise<void> {
    // Static tokens don't need to be saved
  }

  async redirectToAuthorization(): Promise<void> {
    throw new Error('StaticTokenAuthProvider does not support OAuth redirects');
  }

  async saveCodeVerifier(): Promise<void> {
    throw new Error('StaticTokenAuthProvider does not support PKCE');
  }

  async codeVerifier(): Promise<string> {
    throw new Error('StaticTokenAuthProvider does not support PKCE');
  }
}

/**
 * Test-scoped auth fixtures interface
 */
export interface MCPAuthFixtures {
  /**
   * OAuth client provider for MCP authentication
   */
  mcpAuthProvider: OAuthClientProvider | undefined;
}

/**
 * Extended Playwright test with MCP auth fixtures
 *
 * Use this when you need OAuth authentication for MCP server testing.
 *
 * @example
 * ```typescript
 * // test.ts
 * import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';
 *
 * test('authenticated MCP call', async ({ mcpAuthProvider }) => {
 *   // mcpAuthProvider can be passed to createMCPClientForConfig
 * });
 * ```
 */
export const test = base.extend<MCPAuthFixtures>({
  /**
   * Create auth provider based on environment configuration
   */
  // eslint-disable-next-line no-empty-pattern
  mcpAuthProvider: async ({}, use) => {
    const authConfig = getAuthConfigFromEnv();

    if (!authConfig) {
      await use(undefined);
      return;
    }

    // Static token mode
    if (authConfig.accessToken) {
      const provider = new StaticTokenAuthProvider(authConfig.accessToken);
      await use(provider);
      return;
    }

    // OAuth mode
    if (authConfig.oauth) {
      const provider = createOAuthProvider(authConfig.oauth);
      await use(provider);
      return;
    }

    await use(undefined);
  },
});

/**
 * Creates an OAuth provider from configuration
 */
function createOAuthProvider(
  oauthConfig: MCPOAuthConfig
): PlaywrightOAuthClientProvider {
  if (!oauthConfig.authStatePath) {
    throw new Error(
      'OAuth configuration requires authStatePath. ' +
        'Use performOAuthSetup() in globalSetup to create auth state first.'
    );
  }

  const providerConfig: PlaywrightOAuthClientProviderConfig = {
    storagePath: oauthConfig.authStatePath,
    redirectUri:
      oauthConfig.redirectUri ?? 'http://localhost:3000/oauth/callback',
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
  };

  return new PlaywrightOAuthClientProvider(providerConfig);
}

/**
 * Gets auth config from environment variables
 *
 * This is a fallback for fixtures that can't access testInfo.project directly.
 */
function getAuthConfigFromEnv(): MCPAuthConfig | undefined {
  // Check for static token
  const accessToken = process.env.MCP_ACCESS_TOKEN;
  if (accessToken) {
    return { accessToken };
  }

  // Check for OAuth config
  const oauthServerUrl = process.env.MCP_OAUTH_SERVER_URL;
  const authStatePath = process.env.MCP_AUTH_STATE_PATH;

  if (oauthServerUrl || authStatePath) {
    return {
      oauth: {
        serverUrl: oauthServerUrl ?? '',
        authStatePath: authStatePath,
        clientId: process.env.MCP_OAUTH_CLIENT_ID,
        clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
        scopes: process.env.MCP_OAUTH_SCOPES?.split(','),
        resource: process.env.MCP_OAUTH_RESOURCE,
      },
    };
  }

  return undefined;
}

/**
 * Re-export expect for convenience
 */
export { expect } from '@playwright/test';
