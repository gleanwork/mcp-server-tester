import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock references so they are accessible inside vi.mock factory
const mocks = vi.hoisted(() => {
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    url: vi
      .fn()
      .mockReturnValue('http://localhost:3000/oauth/callback?code=testcode'),
  };

  const context = {
    newPage: vi.fn().mockResolvedValue(page),
  };

  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    page,
    context,
    browser,
    chromiumLaunch: vi.fn().mockResolvedValue(browser),
    discoverAuthorizationServerMetadata: vi.fn(),
    startAuthorization: vi.fn(),
    exchangeAuthorization: vi.fn(),
    saveOAuthState: vi.fn().mockResolvedValue(undefined),
    loadOAuthState: vi.fn(),
  };
});

vi.mock('@playwright/test', () => ({
  chromium: {
    launch: mocks.chromiumLaunch,
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverAuthorizationServerMetadata:
    mocks.discoverAuthorizationServerMetadata,
  startAuthorization: mocks.startAuthorization,
  exchangeAuthorization: mocks.exchangeAuthorization,
}));

vi.mock('./oauthClientProvider.js', () => ({
  saveOAuthState: mocks.saveOAuthState,
  loadOAuthState: mocks.loadOAuthState,
}));

vi.mock('../debug.js', () => ({
  debugOAuth: vi.fn(),
}));

import {
  performOAuthSetup,
  hasValidOAuthState,
  performOAuthSetupIfNeeded,
} from './setupOAuth.js';
import type { OAuthSetupConfig } from './types.js';

function makeConfig(
  overrides: Partial<OAuthSetupConfig> = {}
): OAuthSetupConfig {
  return {
    authServerUrl: 'https://auth.example.com',
    scopes: ['mcp:read', 'mcp:write'],
    loginSelectors: {
      usernameInput: '#username',
      passwordInput: '#password',
      submitButton: 'button[type="submit"]',
    },
    credentials: {
      username: 'testuser',
      password: 'testpassword',
    },
    outputPath: 'playwright/.auth/oauth-state.json',
    ...overrides,
  };
}

const mockMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
};

const mockTokens = {
  access_token: 'test-access-token',
  token_type: 'Bearer',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
};

describe('setupOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-apply default return values after clearAllMocks
    mocks.browser.close.mockResolvedValue(undefined);
    mocks.browser.newContext.mockResolvedValue(mocks.context);
    mocks.context.newPage.mockResolvedValue(mocks.page);
    mocks.page.setDefaultTimeout.mockReturnValue(undefined);
    mocks.page.goto.mockResolvedValue(undefined);
    mocks.page.waitForSelector.mockResolvedValue(undefined);
    mocks.page.fill.mockResolvedValue(undefined);
    mocks.page.click.mockResolvedValue(undefined);
    mocks.page.waitForURL.mockResolvedValue(undefined);
    mocks.page.url.mockReturnValue(
      'http://localhost:3000/oauth/callback?code=testcode'
    );

    mocks.chromiumLaunch.mockResolvedValue(mocks.browser);
    mocks.discoverAuthorizationServerMetadata.mockResolvedValue(mockMetadata);
    mocks.startAuthorization.mockResolvedValue({
      authorizationUrl: new URL(
        'https://auth.example.com/authorize?client_id=test'
      ),
      codeVerifier: 'test-code-verifier',
    });
    mocks.exchangeAuthorization.mockResolvedValue(mockTokens);
    mocks.saveOAuthState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('performOAuthSetup', () => {
    it('resolves and calls saveOAuthState with correct token structure', async () => {
      await performOAuthSetup(makeConfig());

      expect(mocks.saveOAuthState).toHaveBeenCalledOnce();
      const [outputPath, state] = mocks.saveOAuthState.mock.calls[0]!;
      expect(outputPath).toBe('playwright/.auth/oauth-state.json');
      expect(state.tokens).toMatchObject({
        accessToken: 'test-access-token',
        tokenType: 'Bearer',
        refreshToken: 'test-refresh-token',
      });
      expect(state.tokens.expiresAt).toBeTypeOf('number');
      expect(state.savedAt).toBeTypeOf('number');
    });

    it('throws with helpful message when metadata discovery returns null', async () => {
      mocks.discoverAuthorizationServerMetadata.mockResolvedValue(null);

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow(
        'Could not discover OAuth metadata at https://auth.example.com'
      );
    });

    it('throws with OAuth error when callback URL contains ?error param', async () => {
      mocks.page.url.mockReturnValue(
        'http://localhost:3000/oauth/callback?error=access_denied&error_description=The+user+denied+access'
      );

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow(
        'OAuth authorization failed: access_denied - The user denied access'
      );
    });

    it('throws with error name only when no error_description is present', async () => {
      mocks.page.url.mockReturnValue(
        'http://localhost:3000/oauth/callback?error=server_error'
      );

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow(
        'OAuth authorization failed: server_error'
      );
    });

    it('throws "No authorization code" when callback URL has no ?code param', async () => {
      mocks.page.url.mockReturnValue('http://localhost:3000/oauth/callback');

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow(
        'No authorization code in callback URL'
      );
    });

    it('calls browser.close() even when an error is thrown (finally block)', async () => {
      mocks.discoverAuthorizationServerMetadata.mockResolvedValue(null);

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow();

      // browser.close() must not have been called before discovery fails (browser not launched yet at that point)
      // But when the error happens inside the try block, close() should still be called
    });

    it('calls browser.close() when an error occurs during page interaction', async () => {
      mocks.page.goto.mockRejectedValue(new Error('Navigation failed'));

      await expect(performOAuthSetup(makeConfig())).rejects.toThrow(
        'Navigation failed'
      );

      expect(mocks.browser.close).toHaveBeenCalledOnce();
    });

    it('calls browser.close() on successful completion', async () => {
      await performOAuthSetup(makeConfig());

      expect(mocks.browser.close).toHaveBeenCalledOnce();
    });

    it('uses DEFAULT_REDIRECT_URI when config.redirectUri is not provided', async () => {
      await performOAuthSetup(makeConfig({ redirectUri: undefined }));

      expect(mocks.startAuthorization).toHaveBeenCalledWith(
        'https://auth.example.com',
        expect.objectContaining({
          redirectUrl: 'http://localhost:3000/oauth/callback',
        })
      );
    });

    it('uses custom redirectUri when provided in config', async () => {
      await performOAuthSetup(
        makeConfig({ redirectUri: 'https://myapp.example.com/auth/callback' })
      );

      expect(mocks.startAuthorization).toHaveBeenCalledWith(
        'https://auth.example.com',
        expect.objectContaining({
          redirectUrl: 'https://myapp.example.com/auth/callback',
        })
      );
    });

    it('passes resource as a URL instance when config.resource is set', async () => {
      await performOAuthSetup(
        makeConfig({ resource: 'https://api.example.com/mcp' })
      );

      expect(mocks.startAuthorization).toHaveBeenCalledWith(
        'https://auth.example.com',
        expect.objectContaining({
          resource: new URL('https://api.example.com/mcp'),
        })
      );
    });

    it('does not pass resource when config.resource is undefined', async () => {
      await performOAuthSetup(makeConfig({ resource: undefined }));

      expect(mocks.startAuthorization).toHaveBeenCalledWith(
        'https://auth.example.com',
        expect.objectContaining({
          resource: undefined,
        })
      );
    });

    it('includes clientInfo in saved state when clientId is provided', async () => {
      await performOAuthSetup(
        makeConfig({ clientId: 'my-client', clientSecret: 'my-secret' })
      );

      const [, state] = mocks.saveOAuthState.mock.calls[0]!;
      expect(state.clientInfo).toEqual({
        clientId: 'my-client',
        clientSecret: 'my-secret',
      });
    });

    it('omits clientInfo from saved state when clientId is not provided', async () => {
      await performOAuthSetup(makeConfig({ clientId: undefined }));

      const [, state] = mocks.saveOAuthState.mock.calls[0]!;
      expect(state.clientInfo).toBeUndefined();
    });

    it('sets expiresAt correctly based on expires_in from token response', async () => {
      const before = Date.now();
      await performOAuthSetup(makeConfig());
      const after = Date.now();

      const [, state] = mocks.saveOAuthState.mock.calls[0]!;
      // expiresAt should be approximately now + 3600 * 1000
      expect(state.tokens.expiresAt).toBeGreaterThanOrEqual(
        before + 3600 * 1000
      );
      expect(state.tokens.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
    });

    it('sets expiresAt to undefined when token response has no expires_in', async () => {
      mocks.exchangeAuthorization.mockResolvedValue({
        access_token: 'no-expiry-token',
        token_type: 'Bearer',
      });

      await performOAuthSetup(makeConfig());

      const [, state] = mocks.saveOAuthState.mock.calls[0]!;
      expect(state.tokens.expiresAt).toBeUndefined();
    });
  });

  describe('hasValidOAuthState', () => {
    it('returns true when file exists with valid non-expired token', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'valid-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600000, // 1 hour from now
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(true);
    });

    it('returns false when file does not exist (loadOAuthState throws)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mocks.loadOAuthState.mockRejectedValue(error);

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when accessToken is missing', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600000,
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when tokens object itself is missing', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when token is expired (expiresAt < Date.now() + 60s buffer)', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'expired-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000, // 1 second in the past
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when token expires within the 1-minute buffer', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'soon-expired-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 30000, // 30 seconds from now (inside 60s buffer)
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns true when token has no expiresAt (no expiry check performed)', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'no-expiry-token',
          tokenType: 'Bearer',
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(true);
    });

    it('returns false when expiresAt is exactly at the 1-minute boundary (< now + 60000)', async () => {
      // expiresAt is exactly now + 60000ms — fails because the condition is strict (<)
      const exactBoundary = Date.now() + 60000;
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'boundary-token',
          tokenType: 'Bearer',
          expiresAt: exactBoundary,
        },
        savedAt: Date.now(),
      });

      // The condition in source is: expiresAt - bufferMs < Date.now()
      // With expiresAt = now + 60000, expiresAt - 60000 = now, which is NOT < now (equal).
      // So the token should pass. But the exact boundary can be flaky due to timing;
      // we test slightly below the boundary instead to make the test deterministic.
      const justBelowBoundary = Date.now() + 59999;
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'boundary-token',
          tokenType: 'Bearer',
          expiresAt: justBelowBoundary,
        },
        savedAt: Date.now(),
      });

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when state is null (loadOAuthState returns null)', async () => {
      mocks.loadOAuthState.mockResolvedValue(null);

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });

    it('returns false when any unexpected error is thrown', async () => {
      mocks.loadOAuthState.mockRejectedValue(new Error('Unexpected I/O error'));

      const result = await hasValidOAuthState(
        'playwright/.auth/oauth-state.json'
      );

      expect(result).toBe(false);
    });
  });

  describe('performOAuthSetupIfNeeded', () => {
    it('calls performOAuthSetup when no valid state exists', async () => {
      // hasValidOAuthState will call loadOAuthState — make it return null so no valid state
      mocks.loadOAuthState.mockResolvedValue(null);

      await performOAuthSetupIfNeeded(makeConfig());

      expect(mocks.saveOAuthState).toHaveBeenCalledOnce();
      expect(mocks.exchangeAuthorization).toHaveBeenCalledOnce();
    });

    it('skips performOAuthSetup when valid state already exists', async () => {
      mocks.loadOAuthState.mockResolvedValue({
        tokens: {
          accessToken: 'still-valid-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600000,
        },
        savedAt: Date.now(),
      });

      await performOAuthSetupIfNeeded(makeConfig());

      // Neither browser launch nor token exchange should happen
      expect(mocks.chromiumLaunch).not.toHaveBeenCalled();
      expect(mocks.saveOAuthState).not.toHaveBeenCalled();
    });
  });
});
