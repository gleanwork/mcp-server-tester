/**
 * `mst token <server-url>`: print the OAuth tokens `mst login` stored, for
 * CI (`>> $GITHUB_ENV`, a JSON file, or `gh secret set` commands).
 *
 * Each value is written on one line, never wrapped, so a piped token is
 * whole.
 */
import {
  createFileOAuthStorage,
  ENV_VAR_NAMES,
  getStateDir,
} from '../../../auth/storage.js';
import type { StoredTokens } from '../../../auth/types.js';
import { status } from '../../utils/format.js';

export const TOKEN_FORMATS = ['env', 'json', 'gh'] as const;
type TokenFormat = (typeof TOKEN_FORMATS)[number];

export interface TokenOptions {
  format?: TokenFormat;
  stateDir?: string;
}

export async function token(
  serverUrl: string,
  options: TokenOptions
): Promise<void> {
  try {
    new URL(serverUrl);
  } catch {
    fail([status('error', `Invalid URL: ${serverUrl}`)]);
    return;
  }

  const storage = createFileOAuthStorage({
    serverUrl,
    stateDir: options.stateDir,
  });
  const tokens = await storage.loadTokens();
  if (!tokens) {
    fail([
      status('error', `No tokens found for ${serverUrl}`),
      `Expected location: ${getStateDir(serverUrl, options.stateDir)}/tokens.json`,
      '',
      `Run 'mst login ${serverUrl}' to authenticate first.`,
    ]);
    return;
  }

  process.stdout.write(`${formatTokens(tokens, options.format ?? 'env')}\n`);
}

/** The variables `mst token` prints, by name, in output order. */
function tokenVariables(tokens: StoredTokens): Array<[string, string]> {
  const variables: Array<[string, string]> = [
    [ENV_VAR_NAMES.accessToken, tokens.accessToken],
  ];
  if (tokens.refreshToken) {
    variables.push([ENV_VAR_NAMES.refreshToken, tokens.refreshToken]);
  }
  variables.push([ENV_VAR_NAMES.tokenType, tokens.tokenType]);
  if (tokens.expiresAt) {
    variables.push([ENV_VAR_NAMES.expiresAt, String(tokens.expiresAt)]);
  }
  return variables;
}

function formatTokens(tokens: StoredTokens, format: TokenFormat): string {
  const variables = tokenVariables(tokens);
  switch (format) {
    case 'env':
      return variables.map(([name, value]) => `${name}=${value}`).join('\n');
    case 'json':
      return JSON.stringify(
        Object.fromEntries(
          variables.map(([name, value]) => [
            name,
            name === ENV_VAR_NAMES.expiresAt ? Number(value) : value,
          ])
        ),
        null,
        2
      );
    case 'gh':
      return [
        '# Run these commands to set GitHub Actions secrets:',
        ...variables.map(
          ([name, value]) => `gh secret set ${name} --body "${value}"`
        ),
      ].join('\n');
  }
}

function fail(lines: string[]): void {
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exitCode = 1;
}
