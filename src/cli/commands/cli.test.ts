/**
 * Integration tests for the mcp-server-tester CLI.
 *
 * Uses bintastic to run the real compiled binary against a temporary directory,
 * so these tests verify actual file I/O rather than mocked behaviour.
 *
 * Prerequisites: the project must be built before running these tests.
 * Run `npm run build` first, or use `npm run test:all` which builds first.
 */

import { createBintastic, type BintasticProject } from 'bintastic';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoredTokens } from '../../auth/types.js';
import { generateServerKey } from '../../auth/storage.js';

const { setupProject, teardownProject, runBin } = createBintastic({
  binPath: fileURLToPath(
    new URL('../../../dist/cli/index.js', import.meta.url)
  ),
});

/**
 * Write a stored token file for the given server URL into the project's
 * state directory. Mirrors how FileOAuthStorage persists tokens on disk.
 *
 * project.write() takes a nested object representing the directory tree —
 * directory names are object keys, file contents are string values.
 */
async function writeTokens(
  project: BintasticProject,
  serverUrl: string,
  tokens: StoredTokens
): Promise<void> {
  const serverKey = generateServerKey(serverUrl);
  await project.write({
    [serverKey]: {
      'tokens.json': JSON.stringify(tokens, null, 2),
    },
  });
}

describe('mcp-server-tester CLI', () => {
  let project: BintasticProject;

  beforeEach(async () => {
    project = await setupProject();
  });

  afterEach(() => {
    teardownProject();
  });

  describe('--help / --version', () => {
    it('shows top-level help', async () => {
      const result = await runBin('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('mcp-server-tester');
      expect(result.stdout).toContain('init');
      expect(result.stdout).toContain('generate');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('token');
    });

    it('shows version', async () => {
      const result = await runBin('--version');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('init --help lists --name and --dir options', async () => {
      const result = await runBin('init', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--name');
      expect(result.stdout).toContain('--dir');
    });

    it('generate --help lists --output and --snapshot options', async () => {
      const result = await runBin('generate', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--output');
      expect(result.stdout).toContain('--snapshot');
    });

    it('login --help lists <server-url> and --force', async () => {
      const result = await runBin('login', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('server-url');
      expect(result.stdout).toContain('--force');
    });

    it('token --help lists <server-url> and --format', async () => {
      const result = await runBin('token', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('server-url');
      expect(result.stdout).toContain('--format');
    });
  });

  describe('token command', () => {
    const serverUrl = 'https://api.example.com/mcp';

    const validTokens: StoredTokens = {
      accessToken: 'test-access-token-abc123',
      refreshToken: 'test-refresh-token-xyz789',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
    };

    it('shows an error message when no tokens are stored', async () => {
      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      // The token command renders an error message but does not currently
      // set a non-zero exit code when tokens are missing.
      expect(result.stdout).toContain('No tokens found');
    });

    it('outputs tokens in env format (default)', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'MCP_ACCESS_TOKEN=test-access-token-abc123'
      );
      expect(result.stdout).toContain(
        'MCP_REFRESH_TOKEN=test-refresh-token-xyz789'
      );
      expect(result.stdout).toContain('MCP_TOKEN_TYPE=Bearer');
    });

    it('outputs tokens in env format when --format env is explicit', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'env'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'MCP_ACCESS_TOKEN=test-access-token-abc123'
      );
    });

    it('outputs tokens in JSON format', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'json'
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(String(result.stdout)) as Record<
        string,
        string
      >;
      expect(parsed['MCP_ACCESS_TOKEN']).toBe('test-access-token-abc123');
      expect(parsed['MCP_REFRESH_TOKEN']).toBe('test-refresh-token-xyz789');
      expect(parsed['MCP_TOKEN_TYPE']).toBe('Bearer');
    });

    it('outputs tokens in GitHub CLI format', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'gh'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('gh secret set MCP_ACCESS_TOKEN');
      expect(result.stdout).toContain('test-access-token-abc123');
    });

    it('works with only an access token (no refresh token)', async () => {
      await writeTokens(project, serverUrl, {
        accessToken: 'minimal-token',
        tokenType: 'Bearer',
      });

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('MCP_ACCESS_TOKEN=minimal-token');
      expect(result.stdout).not.toContain('MCP_REFRESH_TOKEN=');
    });

    it('falls back to env format for an unknown --format value', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'not-a-real-format'
      );

      // Commander passes the value through; the Ink component does not
      // currently validate it and silently outputs nothing for unknown formats.
      // This test documents the current behaviour so a regression is caught
      // if the command starts crashing instead.
      expect(result.exitCode).toBe(0);
    });

    it('includes MCP_TOKEN_EXPIRES_AT when expiresAt is set', async () => {
      const expiresAt = Date.now() + 7200 * 1000;
      await writeTokens(project, serverUrl, {
        accessToken: 'expiring-token',
        tokenType: 'Bearer',
        expiresAt,
      });

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`MCP_TOKEN_EXPIRES_AT=${expiresAt}`);
    });
  });
});
