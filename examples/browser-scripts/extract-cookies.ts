#!/usr/bin/env npx tsx
/**
 * Cookie / Storage State Extraction Script
 *
 * Connects to a running Chrome instance via CDP, navigates to a URL,
 * and saves the Playwright storage state (cookies + localStorage)
 * for use with browser host evals.
 *
 * ## Usage
 *
 * 1. Quit Chrome completely
 * 2. Relaunch with remote debugging:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222
 * 3. Log in to the target site in Chrome
 * 4. Run this script:
 *      npx tsx examples/browser-scripts/extract-cookies.ts https://chatgpt.com
 *
 * Options:
 *   --output <path>    Output file (default: ./auth/storage-state.json)
 *   --cdp-port <port>  CDP port (default: 9222)
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1]
    ? process.argv[idx + 1]
    : undefined;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || url.startsWith('--')) {
    console.error(
      'Usage: npx tsx extract-cookies.ts <url> [--output <path>] [--cdp-port <port>]'
    );
    console.error('\nSteps:');
    console.error(
      '  1. Quit Chrome, relaunch with: Chrome --remote-debugging-port=9222'
    );
    console.error('  2. Log in to the target site');
    console.error(
      '  3. npx tsx extract-cookies.ts https://chatgpt.com --output ./auth/chatgpt-state.json'
    );
    process.exit(1);
  }

  const outputPath = resolve(getArg('--output') ?? './auth/storage-state.json');
  const cdpPort = getArg('--cdp-port') ?? '9222';
  const port = parseInt(cdpPort, 10);

  console.log(`\nConnecting to Chrome on localhost:${port} via CDP...`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  } catch {
    console.error(`\nFailed to connect to Chrome on port ${port}.`);
    console.error('Make sure Chrome is running with remote debugging:');
    console.error(
      `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`
    );
    process.exit(1);
  }

  console.log('Connected!\n');

  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    console.error('No browser context found.');
    browser.disconnect();
    process.exit(1);
  }

  // Navigate to target URL
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  console.log(`Navigated to ${url}`);
  console.log('──────────────────────────────────────────');
  console.log('  Verify you are logged in.');
  console.log('  When ready, press ENTER here.');
  console.log('──────────────────────────────────────────\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((res) => {
    rl.question('Press ENTER to save cookies and exit...', () => {
      rl.close();
      res();
    });
  });

  const storageState = await context.storageState();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(storageState, null, 2));

  console.log(
    `\nSaved ${storageState.cookies.length} cookies and ${storageState.origins.length} localStorage origins to ${outputPath}`
  );

  browser.disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
