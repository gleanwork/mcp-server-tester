#!/usr/bin/env node
/**
 * An npm CLI for tests of `mst env setup docker` (MST_NPM): `pack` writes the
 * tarball npm would name, without running the package's scripts (packing
 * this checkout for real would rebuild dist while other tests use it).
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'pack') {
  process.stderr.write(`fake npm: unsupported command ${args[0]}\n`);
  process.exit(1);
}
const destination = args[args.indexOf('--pack-destination') + 1];
const { name, version } = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
);
const file = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
fs.writeFileSync(path.join(destination, file), '');
process.stdout.write(`${file}\n`);
