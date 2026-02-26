/**
 * OAuth client provider implementation for MCP SDK
 *
 * Implements the MCP SDK's OAuthClientProvider interface using file-based storage
 * for integration with Playwright's auth state pattern.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { StoredOAuthState } from './types.js';

/**
 * Configuration for the Playwright OAuth client provider
 */
export interface PlaywrightOAuthClientProviderConfig {
  /**
   * Path to the auth state file (e.g., playwright/.auth/oauth-state.json)
   */
  storagePath: string;

  /**
   * OAuth redirect URI for callback
   */
  redirectUri: string;

  /**
   * Client metadata for DCR or display
   */
  clientMetadata?: Partial<OAuthClientMetadata>;

  /**
   * Pre-registered client ID (if not using DCR)
   */
  clientId?: string;

  /**
   * Pre-registered client secret (if not using DCR)
   */
  clientSecret?: string;
}

/**
 * OAuth client provider that implements the MCP SDK's OAuthClientProvider interface
 *
 * Uses file-based storage for integration with Playwright's auth state pattern.
 * Auth state is persisted to disk so it can be reused across test runs.
 *
 * @example
 * ```typescript
 * const provider = new PlaywrightOAuthClientProvider({
 *   storagePath: 'playwright/.auth/oauth-state.json',
 *   redirectUri: 'http://localhost:3000/callback',
 * });
 *
 * const transport = new StreamableHTTPClientTransport(serverUrl, {
 *   authProvider: provider,
 * });
 * ```
 */
export class PlaywrightOAuthClientProvider implements OAuthClientProvider {
  private readonly config: PlaywrightOAuthClientProviderConfig;
  private cachedState: StoredOAuthState | null = null;
  private stateParam: string | null = null;

  constructor(config: PlaywrightOAuthClientProviderConfig) {
    this.config = config;
  }

  /**
   * The URL to redirect the user agent to after authorization
   */
  get redirectUrl(): string {
    return this.config.redirectUri;
  }

  /**
   * Metadata about this OAuth client
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.config.redirectUri],
      token_endpoint_auth_method: this.config.clientSecret
        ? 'client_secret_basic'
        : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: '@gleanwork/mcp-server-tester',
      ...this.config.clientMetadata,
    };
  }

  /**
   * Returns an OAuth2 state parameter
   */
  state(): string {
    if (!this.stateParam) {
      this.stateParam = this.generateRandomString(32);
    }
    return this.stateParam;
  }

  /**
   * Loads information about this OAuth client
   */
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // If we have a pre-registered client, return it
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
      };
    }

    // Otherwise, try to load from storage (DCR result)
    const state = await this.loadState();
    if (state?.clientInfo) {
      return {
        client_id: state.clientInfo.clientId,
        client_secret: state.clientInfo.clientSecret,
        client_id_issued_at: state.clientInfo.clientIdIssuedAt,
        client_secret_expires_at: state.clientInfo.clientSecretExpiresAt,
        redirect_uris: [this.config.redirectUri],
      };
    }

    return undefined;
  }

  /**
   * Saves client information from Dynamic Client Registration
   */
  async saveClientInformation(
    clientInformation: OAuthClientInformationFull
  ): Promise<void> {
    const state = (await this.loadState()) ?? this.createEmptyState();
    state.clientInfo = {
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret,
      clientIdIssuedAt: clientInformation.client_id_issued_at,
      clientSecretExpiresAt: clientInformation.client_secret_expires_at,
    };
    await this.saveState(state);
  }

  /**
   * Loads any existing OAuth tokens for the current session
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await this.loadState();
    if (state?.tokens) {
      return {
        access_token: state.tokens.accessToken,
        token_type: state.tokens.tokenType,
        refresh_token: state.tokens.refreshToken,
        expires_in: state.tokens.expiresAt
          ? Math.floor((state.tokens.expiresAt - Date.now()) / 1000)
          : undefined,
      };
    }
    return undefined;
  }

  /**
   * Stores new OAuth tokens for the current session
   *
   * The code verifier is cleared after a successful token exchange — it is
   * single-use per PKCE spec and must not persist beyond the exchange.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = (await this.loadState()) ?? this.createEmptyState();
    state.tokens = {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
    };
    // Clear codeVerifier after successful token exchange — it's single-use per PKCE spec
    delete state.codeVerifier;
    await this.saveState(state);
  }

  /**
   * Invoked to redirect the user agent to the given URL
   *
   * In a testing context, this is typically handled by Playwright automation.
   * This implementation throws an error to signal that the caller needs to
   * handle the redirect externally.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // In a test context, the authorization flow should be handled externally
    // by Playwright automation (e.g., in globalSetup)
    throw new Error(
      `OAuth authorization required. Redirect to: ${authorizationUrl.toString()}\n` +
        'In a testing context, use performOAuthSetup() in your Playwright globalSetup ' +
        'to complete the OAuth flow before running tests.'
    );
  }

  /**
   * Saves a PKCE code verifier for the current session
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = (await this.loadState()) ?? this.createEmptyState();
    state.codeVerifier = codeVerifier;
    await this.saveState(state);
  }

  /**
   * Loads the PKCE code verifier for the current session
   */
  async codeVerifier(): Promise<string> {
    const state = await this.loadState();
    if (!state?.codeVerifier) {
      throw new Error('No code verifier found in auth state');
    }
    return state.codeVerifier;
  }

  /**
   * Invalidates the specified credentials
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier'
  ): Promise<void> {
    const state = await this.loadState();
    if (!state) {
      return;
    }

    switch (scope) {
      case 'all':
        await this.deleteState();
        break;
      case 'client':
        delete state.clientInfo;
        await this.saveState(state);
        break;
      case 'tokens':
        delete state.tokens;
        await this.saveState(state);
        break;
      case 'verifier':
        delete state.codeVerifier;
        await this.saveState(state);
        break;
    }
  }

  // ---- Private helper methods ----

  private async loadState(): Promise<StoredOAuthState | null> {
    if (this.cachedState) {
      return this.cachedState;
    }

    try {
      const content = await fs.readFile(this.config.storagePath, 'utf-8');
      this.cachedState = JSON.parse(content) as StoredOAuthState;
      return this.cachedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async saveState(state: StoredOAuthState): Promise<void> {
    state.savedAt = Date.now();
    this.cachedState = state;

    // Ensure directory exists
    const dir = path.dirname(this.config.storagePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(
      this.config.storagePath,
      JSON.stringify(state, null, 2),
      'utf-8'
    );
  }

  private async deleteState(): Promise<void> {
    this.cachedState = null;
    try {
      await fs.unlink(this.config.storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private createEmptyState(): StoredOAuthState {
    return {
      savedAt: Date.now(),
    };
  }

  private generateRandomString(length: number): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      const randomValue = randomValues[i] ?? 0;
      result += chars[randomValue % chars.length];
    }
    return result;
  }
}

/**
 * Loads OAuth state from a single file (Playwright auth pattern)
 *
 * This function reads from Playwright's single-file auth state format,
 * typically created by `performOAuthSetup` in globalSetup.
 *
 * **Note:** This does NOT work with tokens stored by the CLI (`mcp-server-tester login`).
 * For CLI-stored tokens, use `loadTokens(serverUrl)` instead.
 *
 * @param storagePath - Path to the auth state file (e.g., 'playwright/.auth/oauth-state.json')
 * @returns The stored OAuth state, or null if not found
 *
 * @example
 * ```typescript
 * // Load Playwright auth state
 * const state = await loadOAuthState('playwright/.auth/oauth-state.json');
 * ```
 */
export async function loadOAuthState(
  storagePath: string
): Promise<StoredOAuthState | null> {
  try {
    const content = await fs.readFile(storagePath, 'utf-8');
    return JSON.parse(content) as StoredOAuthState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Saves OAuth state to a single file (Playwright auth pattern)
 *
 * This function writes to Playwright's single-file auth state format.
 * Used by `performOAuthSetup` in globalSetup.
 *
 * **Note:** This does NOT work with the CLI storage format (`mcp-server-tester login`).
 * For programmatic token injection compatible with CLI, use `injectTokens(serverUrl, tokens)`.
 *
 * @param storagePath - Path to the auth state file (e.g., 'playwright/.auth/oauth-state.json')
 * @param state - The OAuth state to save
 *
 * @example
 * ```typescript
 * // Save Playwright auth state
 * await saveOAuthState('playwright/.auth/oauth-state.json', {
 *   tokens: { accessToken: '...', tokenType: 'Bearer' },
 *   savedAt: Date.now(),
 * });
 * ```
 */
export async function saveOAuthState(
  storagePath: string,
  state: StoredOAuthState
): Promise<void> {
  state.savedAt = Date.now();

  // Ensure directory exists
  const dir = path.dirname(storagePath);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(storagePath, JSON.stringify(state, null, 2), 'utf-8');
}
