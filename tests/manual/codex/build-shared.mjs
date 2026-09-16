import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceCheckoutInputs = [
  join(root, '.git'),
  join(root, 'src'),
  join(root, 'tests', 'fixtures', 'desktop-evals'),
  join(root, 'tests', 'manual', 'codex', 'tsconfig.shared.json'),
];
try {
  await Promise.all(sourceCheckoutInputs.map((path) => access(path)));
} catch {
  throw new Error(
    'build:codex-shared is source-checkout-only and requires repository sources.'
  );
}

console.log('Building source-checkout-only shared Codex suite.');
const output = join(root, 'build', 'codex-shared');
await rm(output, { recursive: true, force: true });
execFileSync(
  'npm',
  [
    'exec',
    '--',
    'tsc',
    '-p',
    join(root, 'tests', 'manual', 'codex', 'tsconfig.shared.json'),
  ],
  { cwd: root, stdio: 'inherit' }
);
const runtimeOutput = join(output, 'tests', 'fixtures', 'desktop-evals');
await mkdir(runtimeOutput, { recursive: true });
await cp(
  join(root, 'tests', 'fixtures', 'desktop-evals', 'server.mjs'),
  join(runtimeOutput, 'server.mjs')
);
console.log(`Built source-checkout-only shared Codex suite: ${output}`);
