/**
 * Writes schema/run/v1/<kind>.schema.json from the run format's Zod schemas.
 * Run with `npm run schema:generate`; src/evals/runFormat.test.ts fails when
 * the committed files differ.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { RUN_SCHEMAS } from '../src/evals/runFormat.js';
import { runJsonSchema } from '../src/evals/runSchemas.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'schema', 'run', 'v1');
await fs.mkdir(dir, { recursive: true });
for (const kind of Object.keys(RUN_SCHEMAS) as Array<keyof typeof RUN_SCHEMAS>)
  await fs.writeFile(
    path.join(dir, `${kind}.schema.json`),
    await prettier.format(JSON.stringify(runJsonSchema(kind)), {
      parser: 'json',
    })
  );
console.log(`Wrote ${Object.keys(RUN_SCHEMAS).length} schemas to ${dir}`);
