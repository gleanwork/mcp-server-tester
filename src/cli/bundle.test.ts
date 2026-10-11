/**
 * The CLI bundles its terminal UI (Ink and React), so it never loads the host
 * project's React (#424). Runs against the built CLI: `npm run build` first.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const UI_PACKAGES = [
  'ink',
  'ink-spinner',
  '@inkjs/ui',
  'react',
  'react-reconciler',
  'scheduler',
];
const UI_SPECIFIER = new RegExp(
  `^(${UI_PACKAGES.map((name) => name.replace('/', '\\/')).join('|')})(\\/|$)`
);

describe('CLI bundle', () => {
  it('loads none of its UI packages from node_modules', () => {
    const source = fs.readFileSync(CLI, 'utf8');
    const loaded = [
      ...source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\$\d+)?\s*\(\s*)["']([^"']+)["']/g
      ),
    ]
      .map((match) => match[1]!)
      .filter((specifier) => UI_SPECIFIER.test(specifier));
    expect(loaded).toEqual([]);
  });

  describe('when the host project has its own React', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-cli-bundle-'));
      // Fails the run if the CLI resolves a UI package from outside its
      // bundle, as Ink did when it found a React 19 project's `react`.
      fs.writeFileSync(
        path.join(dir, 'hooks.mjs'),
        `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (${UI_SPECIFIER}.test(specifier))
      throw new Error('The CLI loaded ' + specifier + ' from node_modules');
    return next(specifier, context);
  },
});
`
      );
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it.skipIf(typeof module.registerHooks !== 'function')(
      'starts without it',
      () => {
        const output = execFileSync(
          process.execPath,
          ['--import', path.join(dir, 'hooks.mjs'), CLI, '--help'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        expect(output).toContain('Usage: mst');
      }
    );
  });
});
