import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

interface PackageManifest {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Stage only an installed MST's publishable files, without pack lifecycle hooks.
 * npm 10's pacote runs prepare even with --ignore-scripts. Never rewrite the
 * installed manifest, even temporarily: other processes can be using it.
 * The caller owns the staging directory and removes it in finally.
 */
export async function stageInstalledPackage(
  root: string,
  destination: string
): Promise<void> {
  // npm-packlist accepts an Arborist-shaped tree. This package has no bundled
  // dependencies: listing its own files needs no dependency tree or npm internals.
  const require = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  );
  const packlist = require('npm-packlist') as (tree: {
    path: string;
    package: PackageManifest;
    isProjectRoot: true;
  }) => Promise<string[]>;
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8')
  ) as PackageManifest;
  const files = await packlist({
    path: root,
    // Dependencies are installed by the image, never copied from this machine.
    package: { ...manifest, bundleDependencies: [] },
    isProjectRoot: true,
  });
  for (const file of files) {
    const parts = file.split(/[\\/]/);
    if (
      path.isAbsolute(file) ||
      parts.some(
        (part) =>
          part === '..' ||
          part === 'node_modules' ||
          part === '.git' ||
          part === '.npmrc' ||
          part === '.env' ||
          part.startsWith('.env.')
      )
    )
      continue;
    const source = path.join(root, file);
    // packlist excludes symlinks; do not dereference one if a file changed
    // between listing and copying either.
    if (!(await fs.lstat(source)).isFile()) continue;
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  if (manifest.scripts) {
    for (const hook of ['prepack', 'prepare', 'postpack'])
      delete manifest.scripts[hook];
  }
  await fs.writeFile(
    path.join(destination, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}
