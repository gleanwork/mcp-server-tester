/**
 * Auth types for MCP OAuth integration
 */

import type { Page } from '@playwright/test';

/**
 * Stored OAuth tokens
 */
export interface StoredTokens {
  /**
   * OAuth access token
   */
  accessToken: string;

  /**
   * OAuth refresh token (if provided)
   */
  refreshToken?: string;

  /**
   * Token expiration timestamp (Unix milliseconds)
   */
  expiresAt?: number;

  /**
   * Token type (typically "Bearer")
   */
  tokenType: string;

  /**
   * Client ID that was used to obtain these tokens.
   * Required for token refresh since refresh tokens are bound to the client.
   */
  clientId?: string;
}

/**
 * Stored client information from Dynamic Client Registration
 */
export interface StoredClientInfo {
  /**
   * Client ID from DCR
   */
  clientId: string;

  /**
   * Client secret from DCR (for confidential clients)
   */
  clientSecret?: string;

  /**
   * Client ID issued at timestamp
   */
  clientIdIssuedAt?: number;

  /**
   * Client secret expiration timestamp
   */
  clientSecretExpiresAt?: number;
}

/**
 * Complete OAuth state persisted to disk for Playwright auth state pattern
 */
export interface StoredOAuthState {
  /**
   * OAuth tokens
   */
  tokens?: StoredTokens;

  /**
   * DCR client information
   */
  clientInfo?: StoredClientInfo;

  /**
   * PKCE code verifier (used during authorization flow)
   */
  codeVerifier?: string;

  /**
   * OAuth state parameter (for CSRF protection)
   */
  state?: string;

  /**
   * Timestamp when this state was saved
   */
  savedAt: number;
}

/**
 * Login form selectors for standard OAuth login automation
 */
export interface OAuthLoginSelectors {
  /** Selector for username/email input field */
  usernameInput: string;
  /** Selector for password input field */
  passwordInput: string;
  /** Selector for login submit button */
  submitButton: string;
  /** Selector for consent/authorize button (optional) */
  consentButton?: string;
}

/**
 * Base configuration shared by all OAuth setup strategies
 */
interface OAuthSetupBaseConfig {
  /** OAuth authorization server metadata URL */
  authServerUrl: string;
  /** Scopes to request */
  scopes: Array<string>;
  /** Path to save OAuth state file */
  outputPath: string;
  /** Pre-registered client ID (optional, uses DCR if not provided) */
  clientId?: string;
  /** Pre-registered client secret (optional) */
  clientSecret?: string;
  /** Redirect URI for OAuth callback */
  redirectUri?: string;
  /** Resource indicator (RFC 8707) */
  resource?: string;
  /** Timeout for login flow in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Standard login strategy: automates a form with username, password, and submit button.
 * Use when the IdP presents all login fields on a single page.
 */
interface StandardLoginConfig {
  /** Login form selectors for Playwright automation */
  loginSelectors: OAuthLoginSelectors;
  /** Test user credentials */
  credentials: { username: string; password: string };
  customLoginFlow?: never;
}

/**
 * Custom login strategy: full control over the browser-based login flow.
 * Use for multi-step logins, MFA, custom consent screens, or any flow
 * that doesn't fit the standard username/password/submit pattern.
 *
 * The callback receives a Playwright Page already navigated to the OAuth
 * authorization URL. Complete the login so the IdP redirects to the
 * callback URL — `performOAuthSetup` handles PKCE, token exchange,
 * and state persistence automatically.
 */
interface CustomLoginConfig {
  /**
   * Custom Playwright automation for the IdP login flow.
   *
   * @param page - Playwright Page already navigated to the OAuth authorization URL
   *
   * @example
   * ```typescript
   * customLoginFlow: async (page) => {
   *   await page.fill('#username', process.env.TEST_USER!);
   *   await page.click('#continue');
   *   await page.fill('#password', process.env.TEST_PASS!);
   *   await page.click('#submit');
   * }
   * ```
   */
  customLoginFlow: (page: Page) => Promise<void>;
  loginSelectors?: never;
  credentials?: never;
}

/**
 * Configuration for OAuth setup flow.
 *
 * Provide either `loginSelectors` + `credentials` for standard form-based login,
 * or `customLoginFlow` for full control over the browser automation.
 */
export type OAuthSetupConfig = OAuthSetupBaseConfig &
  (StandardLoginConfig | CustomLoginConfig);

/**
 * Result of token exchange or refresh
 */
export interface TokenResult {
  /**
   * Access token
   */
  accessToken: string;

  /**
   * Token type (typically "Bearer")
   */
  tokenType: string;

  /**
   * Expires in seconds
   */
  expiresIn?: number;

  /**
   * Refresh token (if provided)
   */
  refreshToken?: string;

  /**
   * Granted scopes (space-separated)
   */
  scope?: string;
}
