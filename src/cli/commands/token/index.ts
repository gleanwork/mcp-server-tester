/**
 * CLI token command for extracting stored OAuth tokens
 *
 * Outputs tokens in formats suitable for CI/CD environments like GitHub Actions.
 */

import { render } from 'ink';
import React from 'react';
import { TokenApp, type TokenOptions } from './TokenApp.js';

/**
 * Token command action handler using Ink
 *
 * @param serverUrl - MCP server URL to get tokens for
 * @param options - Command options
 */
export async function token(
  serverUrl: string,
  options: TokenOptions
): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(TokenApp, { serverUrl, options })
  );
  await waitUntilExit();
}

export type { TokenOptions };
