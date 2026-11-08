/**
 * `mst login <server-url>`: sign in to an MCP server with OAuth and store
 * the tokens for tests and `mst token`.
 *
 * It asks nothing, so it runs without a terminal too: with no terminal or no
 * display it prints the sign-in URL instead of opening a browser, then waits
 * for the redirect.
 */
import { CLIOAuthClient } from '../../../auth/cli.js';
import { getStateDir } from '../../../auth/storage.js';
import { status } from '../../utils/format.js';

export interface LoginOptions {
  force?: boolean;
  stateDir?: string;
  scopes?: string;
}

export async function login(
  serverUrl: string,
  options: LoginOptions
): Promise<void> {
  try {
    new URL(serverUrl);
  } catch {
    fail(`Invalid URL: ${serverUrl}`);
    return;
  }

  const scopes = options.scopes
    ? options.scopes.split(',').map((scope) => scope.trim())
    : undefined;
  const client = new CLIOAuthClient({
    mcpServerUrl: serverUrl,
    stateDir: options.stateDir,
    scopes,
  });

  try {
    if (options.force) {
      print('Clearing stored credentials...');
      await client.clearCredentials();
    }
    print(`Authenticating with ${serverUrl}...`);
    print('A browser window may open for OAuth login.');
    const result = await client.getAccessToken();

    print('');
    print(
      result.fromEnv
        ? status('info', 'Using token from environment variables.')
        : result.refreshed
          ? status('success', 'Token refreshed successfully.')
          : status('success', 'Authentication successful!')
    );
    if (result.requestedScopes && result.requestedScopes.length > 0) {
      print(`Scopes: ${result.requestedScopes.join(', ')}`);
    }
    print(
      result.expiresAt
        ? `Token expires: ${new Date(result.expiresAt).toLocaleString()}`
        : 'Token has no expiration.'
    );
    if (!result.fromEnv) {
      print(`Tokens stored in: ${getStateDir(serverUrl, options.stateDir)}`);
    }
  } catch (error) {
    fail(
      `Authentication failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${status('error', message)}\n`);
  process.exitCode = 1;
}
