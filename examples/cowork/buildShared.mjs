import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceCheckoutInputs = [
  join(root, '.git'),
  join(root, 'src'),
  join(root, 'tests', 'fixtures', 'desktop-evals'),
  join(root, 'examples', 'cowork', 'tsconfig.shared.json'),
];
try {
  await Promise.all(sourceCheckoutInputs.map((path) => access(path)));
} catch {
  throw new Error(
    'build:cowork-shared is source-checkout-only and requires repository sources.'
  );
}
console.log('Building source-checkout-only shared Cowork suite.');
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
const output = join(root, 'build', 'cowork-shared');
await rm(output, { recursive: true, force: true });
execFileSync(
  'npm',
  [
    'exec',
    '--',
    'tsc',
    '-p',
    join(root, 'examples', 'cowork', 'tsconfig.shared.json'),
  ],
  { cwd: root, stdio: 'inherit' }
);
await cp(join(root, 'dist'), join(output, 'dist'), { recursive: true });
const runtimeOutput = join(output, 'tests', 'fixtures', 'desktop-evals');
await mkdir(runtimeOutput, { recursive: true });
await cp(
  join(root, 'tests', 'fixtures', 'desktop-evals', 'server.mjs'),
  join(runtimeOutput, 'server.mjs')
);
console.log(`Built source-checkout-only shared Cowork suite: ${output}`);
