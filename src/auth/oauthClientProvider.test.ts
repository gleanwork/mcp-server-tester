import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises before importing the module under test
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));

import { PlaywrightOAuthClientProvider } from './oauthClientProvider.js';

describe('PlaywrightOAuthClientProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveTokens', () => {
    it('clears codeVerifier after successful token exchange', async () => {
      const storedState = {
        codeVerifier: 'pkce-code-verifier-value',
        savedAt: Date.now(),
      };
      // Return a state with codeVerifier pre-populated (simulates state after saveCodeVerifier)
      mocks.readFile.mockResolvedValueOnce(JSON.stringify(storedState));

      const provider = new PlaywrightOAuthClientProvider({
        storagePath: '/tmp/test-auth/oauth-state.json',
        redirectUri: 'http://localhost:3000/callback',
      });

      await provider.saveTokens({
        access_token: 'test-access-token',
        token_type: 'Bearer',
      });

      // The written state must NOT contain codeVerifier
      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const writtenContent = JSON.parse(
        mocks.writeFile.mock.calls[0]![1] as string
      ) as Record<string, unknown>;
      expect(writtenContent).not.toHaveProperty('codeVerifier');
      expect(writtenContent).toHaveProperty('tokens');
    });
  });
});
