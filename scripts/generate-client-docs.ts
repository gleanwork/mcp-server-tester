/**
 * Writes the built-in clients' table in docs/evaluation-framework.md from
 * their definitions. Run with `npm run docs:clients`;
 * src/cli/commands/clients/clients.test.ts fails when the docs differ.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_DOCS_FILE,
  clientDocsBlock,
  withClientDocs,
} from '../src/cli/commands/clients/docs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, CLIENT_DOCS_FILE);
await fs.writeFile(
  file,
  withClientDocs(await fs.readFile(file, 'utf8'), await clientDocsBlock())
);
console.log(`Wrote the clients table in ${CLIENT_DOCS_FILE}`);
