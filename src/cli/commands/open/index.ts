/**
 * CLI open command for viewing the MCP eval reporter UI in the browser.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface OpenOptions {
  dir?: string;
}

/**
 * Open command action handler.
 *
 * Resolves the report output directory, checks that an index.html exists under
 * `latest/`, and opens it in the default browser.
 */
export async function open(options: OpenOptions): Promise<void> {
  const outputDir = resolve(options.dir ?? '.mcp-test-results');
  const reportPath = join(outputDir, 'latest', 'index.html');

  if (!existsSync(reportPath)) {
    console.error(`No report found at ${reportPath}`);
    console.error('Run your Playwright tests first to generate a report.');
    process.exit(1);
  }

  console.log(`Opening report: ${reportPath}`);

  try {
    const { default: openBrowser } = await import('open');
    await openBrowser(reportPath);
  } catch (error) {
    console.error('Failed to open report in browser:', error);
    console.error(`Open manually: file://${reportPath}`);
    process.exit(1);
  }
}
