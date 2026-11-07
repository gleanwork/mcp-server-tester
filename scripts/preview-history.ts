#!/usr/bin/env tsx
/**
 * Preview an eval's history page: six "weekly" runs of a small eval on a
 * scripted client (no model, no network; tests/mocks/weeklyHistory.ts),
 * then print the history page's path.
 *
 * Usage:
 *   npm run build:ui && npm run preview-history            # into a temporary directory
 *   npm run preview-history -- <directory>                 # into <directory>
 *   npm run preview-history -- --open                      # and open it
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { weeklyRuns } from '../tests/mocks/weeklyHistory.js';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const dir = target
  ? path.resolve(target)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'mst-history-'));
await fs.mkdir(dir, { recursive: true });
const evalDirectory = await weeklyRuns(dir);
const page = path.join(evalDirectory, 'history', 'index.html');
console.log(`Eval directory: ${evalDirectory}`);
console.log(`History: ${page}`);
if (args.includes('--open')) {
  const { default: open } = await import('open');
  await open(page);
}
