import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@gleanwork/mcp-server-tester';

/** The installed MST package's directory: the nearest package.json named for MST. */
export function packageRoot(): string {
  let directory = dirname(
    typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  );
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
      };
      if (name === PACKAGE_NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot find the ${PACKAGE_NAME} package.`);
    directory = parent;
  }
}
