#!/usr/bin/env node
/**
 * Runs `npm run build` and fails when Rollup (tsup's `treeshake` pass) reports
 * an import from an external package that a bundle never uses.
 *
 * The warning means a bundle uses part of a module and esbuild dropped the
 * rest but kept that rest's imports. Fix it at the source: move the code that
 * uses the import into its own module, so bundles that don't need the code
 * leave the module (and its import) out. tsup has no way to silence just this
 * warning, and it shouldn't be silenced: each one is code a bundle half-carries.
 */
import { spawn } from 'node:child_process';

const UNUSED_EXTERNAL_IMPORT =
  /^.+ (?:is|are) imported from external module ".+" but never used in ".+"\.$/;

const child = spawn('npm', ['run', 'build'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

const warnings = [];
let pending = { stdout: '', stderr: '' };

function scan(stream, chunk) {
  const text = pending[stream] + chunk.toString();
  const lines = text.split('\n');
  pending[stream] = lines.pop() ?? '';
  for (const line of lines) collect(line);
}

function collect(line) {
  // Strip ANSI colors before matching.
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (UNUSED_EXTERNAL_IMPORT.test(plain)) warnings.push(plain);
}

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  scan('stdout', chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  scan('stderr', chunk);
});

child.on('close', (code, signal) => {
  collect(pending.stdout);
  collect(pending.stderr);
  if (code !== 0) {
    console.error(`\nbuild failed (${signal ?? `exit ${code}`})`);
    process.exit(code ?? 1);
  }
  if (warnings.length > 0) {
    console.error(
      `\nbuild:check: ${warnings.length} unused external import(s) in the bundles:\n` +
        warnings.map((warning) => `  ${warning}`).join('\n') +
        '\n\nA bundle uses part of a module whose other code imports these names.' +
        '\nMove the code that uses them into its own module (see scripts/check-build.mjs).'
    );
    process.exit(1);
  }
  console.log('\nbuild:check: no unused external imports in the bundles');
});
