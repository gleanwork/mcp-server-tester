/**
 * OAuth setup utility for Playwright globalSetup
 *
 * Performs the browser-based OAuth flow and saves the auth state
 * for reuse across tests following Playwright's auth state pattern.
 */

import { chromium, type Page } from '@playwright/test';
import {
  discoverAuthorizationServerMetadata,
  startAuthorization,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthSetupConfig, StoredOAuthState } from './types.js';
import { saveOAuthState } from './oauthClientProvider.js';
import { debugOAuth } from '../debug.js';

/**
 * Default timeout for OAuth login flow (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Default redirect URI for OAuth callback
 */
const DEFAULT_REDIRECT_URI = 'http://localhost:3000/oauth/callback';

/**
 * Performs the OAuth authorization flow using Playwright browser automation
 *
 * This function is designed to be used in Playwright's globalSetup to
 * authenticate once before running tests. The resulting auth state is
 * saved to disk and reused across tests.
 *
 * @param config - OAuth setup configuration
 *
 * @example
 * ```typescript
 * // global-setup.ts
 * import { performOAuthSetup } from '@gleanwork/mcp-server-tester';
 *
 * export default async function globalSetup() {
 *   await performOAuthSetup({
 *     authServerUrl: 'https://auth.example.com',
 *     scopes: ['mcp:read', 'mcp:write'],
 *     loginSelectors: {
 *       usernameInput: '#username',
 *       passwordInput: '#password',
 *       submitButton: 'button[type="submit"]',
 *     },
 *     credentials: {
 *       username: process.env.TEST_USER!,
 *       password: process.env.TEST_PASSWORD!,
 *     },
 *     outputPath: 'playwright/.auth/oauth-state.json',
 *   });
 * }
 * ```
 */
export async function performOAuthSetup(
  config: OAuthSetupConfig
): Promise<void> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redirectUri = config.redirectUri ?? DEFAULT_REDIRECT_URI;

  // 1. Discover OAuth authorization server metadata
  const metadata = await discoverAuthorizationServerMetadata(
    config.authServerUrl
  );

  if (!metadata) {
    throw new Error(
      `Could not discover OAuth metadata at ${config.authServerUrl}`
    );
  }

  // 2. Build client information
  const clientInformation = {
    client_id: config.clientId ?? 'mcp-server-tester-client',
    client_secret: config.clientSecret,
  };

  // 3. Start authorization flow (generates PKCE, builds auth URL)
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    config.authServerUrl,
    {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope: config.scopes.join(' '),
      resource: config.resource ? new URL(config.resource) : undefined,
    }
  );

  // 4. Launch browser and complete login flow
  const browser = await chromium.launch({
    headless: process.env.OAUTH_DEBUG !== 'true',
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Set timeout for the entire flow
    page.setDefaultTimeout(timeoutMs);

    // Navigate to authorization URL
    await page.goto(authorizationUrl.toString());

    // Complete login form
    await completeLoginForm(page, config);

    // Wait for redirect with authorization code
    await page.waitForURL(
      (url) => url.href.startsWith(redirectUri) && url.searchParams.has('code'),
      { timeout: timeoutMs }
    );

    // Extract authorization code from callback URL
    const callbackUrl = new URL(page.url());
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');

    if (error) {
      const errorDescription =
        callbackUrl.searchParams.get('error_description');
      throw new Error(
        `OAuth authorization failed: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`
      );
    }

    if (!code) {
      throw new Error('No authorization code in callback URL');
    }

    // 5. Exchange authorization code for tokens
    const tokens = await exchangeAuthorization(config.authServerUrl, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri,
      resource: config.resource ? new URL(config.resource) : undefined,
    });

    // 6. Save auth state to disk
    // codeVerifier is intentionally excluded: it is single-use per PKCE spec
    // and must not be persisted after a successful token exchange.
    const state: StoredOAuthState = {
      tokens: {
        accessToken: tokens.access_token,
        tokenType: tokens.token_type,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
      },
      clientInfo: config.clientId
        ? {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          }
        : undefined,
      savedAt: Date.now(),
    };

    await saveOAuthState(config.outputPath, state);

    debugOAuth('Auth state saved to %s', config.outputPath);
  } finally {
    await browser.close();
  }
}

/**
 * Completes the login form using the provided selectors
 */
async function completeLoginForm(
  page: Page,
  config: OAuthSetupConfig
): Promise<void> {
  const { loginSelectors, credentials } = config;

  // Wait for and fill username
  await page.waitForSelector(loginSelectors.usernameInput, {
    state: 'visible',
  });
  await page.fill(loginSelectors.usernameInput, credentials.username);

  // Wait for and fill password
  await page.waitForSelector(loginSelectors.passwordInput, {
    state: 'visible',
  });
  await page.fill(loginSelectors.passwordInput, credentials.password);

  // Click submit button
  await page.waitForSelector(loginSelectors.submitButton, {
    state: 'visible',
  });
  await page.click(loginSelectors.submitButton);

  // Handle consent button if present
  if (loginSelectors.consentButton) {
    try {
      await page.waitForSelector(loginSelectors.consentButton, {
        state: 'visible',
        timeout: 5000,
      });
      await page.click(loginSelectors.consentButton);
    } catch {
      // Consent button may not appear if already consented
    }
  }
}

/**
 * Checks if OAuth state exists and contains valid tokens (Playwright auth pattern)
 *
 * This function checks Playwright's single-file auth state format,
 * typically created by `performOAuthSetup` in globalSetup.
 *
 * **Note:** This does NOT work with tokens stored by the CLI (`mcp-server-tester login`).
 * For CLI-stored tokens, use `hasValidTokens(serverUrl)` instead.
 *
 * @param storagePath - Path to the auth state file (e.g., 'playwright/.auth/oauth-state.json')
 * @returns true if valid auth state exists
 *
 * @example
 * ```typescript
 * // Check Playwright auth state
 * if (await hasValidOAuthState('playwright/.auth/oauth-state.json')) {
 *   console.log('Auth state is valid, skipping OAuth setup');
 * }
 * ```
 */
export async function hasValidOAuthState(
  storagePath: string
): Promise<boolean> {
  try {
    const { loadOAuthState } = await import('./oauthClientProvider.js');
    const state = await loadOAuthState(storagePath);

    if (!state?.tokens?.accessToken) {
      return false;
    }

    // Check if token is expired (with 1 minute buffer)
    if (state.tokens.expiresAt) {
      const bufferMs = 60000;
      if (state.tokens.expiresAt - bufferMs < Date.now()) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Performs OAuth setup only if valid state doesn't already exist
 *
 * Use this in globalSetup to avoid re-authenticating on every test run.
 *
 * @param config - OAuth setup configuration
 *
 * @example
 * ```typescript
 * // global-setup.ts
 * export default async function globalSetup() {
 *   await performOAuthSetupIfNeeded({
 *     authServerUrl: 'https://auth.example.com',
 *     scopes: ['mcp:read'],
 *     loginSelectors: { ... },
 *     credentials: { ... },
 *     outputPath: 'playwright/.auth/oauth-state.json',
 *   });
 * }
 * ```
 */
export async function performOAuthSetupIfNeeded(
  config: OAuthSetupConfig
): Promise<void> {
  const hasValid = await hasValidOAuthState(config.outputPath);

  if (hasValid) {
    debugOAuth('Using existing auth state from %s', config.outputPath);
    return;
  }

  debugOAuth('No valid auth state found, performing OAuth flow...');
  await performOAuthSetup(config);
}
