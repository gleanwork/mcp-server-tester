/**
 * Writes schema/run/v1/<kind>.schema.json from the run format's Zod schemas,
 * and schema/history/v1/history.schema.json from the history format's.
 * Run with `npm run schema:generate`; src/evals/runFormat.test.ts and
 * src/evals/historyFormat.test.ts fail when the committed files differ.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { RUN_SCHEMAS } from '../src/evals/runFormat.js';
import { runJsonSchema } from '../src/evals/runSchemas.js';
import { historyJsonSchema } from '../src/evals/historyFormat.js';

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
const historyDir = path.join(root, 'schema', 'history', 'v1');
await fs.mkdir(historyDir, { recursive: true });
await fs.writeFile(
  path.join(historyDir, 'history.schema.json'),
  await prettier.format(JSON.stringify(historyJsonSchema()), {
    parser: 'json',
  })
);
console.log(`Wrote the history schema to ${historyDir}`);
