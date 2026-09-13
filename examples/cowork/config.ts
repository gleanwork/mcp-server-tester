import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { requireAbsent } from './files.js';

export const FIXTURE_LABEL = 'nonce-fixture';
export const FIXTURE_TOOL = 'get_eval_nonce';
export const SCENARIO =
  'Call the installed MCP Server Tester E2E get_eval_nonce tool exactly once, ' +
  'with no arguments. Return its complete text verbatim. Do not use other tools, ' +
  'read files, or guess the value.';

const absolutePath = z
  .string()
  .refine(
    (value) => isAbsolute(value) && !value.includes('REPLACE_ME'),
    'Use an absolute path and replace every REPLACE_ME placeholder'
  );
const configSchema = z
  .object({
    runtimePath: absolutePath,
    dataDir: absolutePath,
    outputDir: absolutePath,
    evaluatorFile: absolutePath,
    servers: z.tuple([
      z
        .object({
          transport: z.literal('stdio'),
          label: z.literal(FIXTURE_LABEL),
          command: z.string().min(1),
          args: z.tuple([absolutePath]),
        })
        .strict(),
    ]),
    mcpServerPrefixes: z
      .record(z.string(), z.literal(FIXTURE_LABEL))
      .refine(
        (prefixes) =>
          Object.keys(prefixes).length === 1 &&
          Object.keys(prefixes).every(
            (prefix) =>
              /^mcp__[A-Za-z0-9_-]+__$/.test(prefix) &&
              !prefix.includes('REPLACE_ME')
          ),
        'Set one verified native mcp__<namespace>__ prefix'
      ),
  })
  .strict();
const evaluatorSchema = z
  .object({
    version: z.literal(1),
    expectedText: z.string().regex(/^MCP_E2E_NONCE_[a-f0-9]{64}$/),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type CoworkExampleConfig = z.infer<typeof configSchema>;

export function parseConfig(value: unknown): CoworkExampleConfig {
  return configSchema.parse(value);
}

export function fixtureReceiptPath(config: CoworkExampleConfig): string {
  return join(dirname(config.evaluatorFile), 'armed.json');
}

export async function readEvaluator(config: CoworkExampleConfig) {
  const evaluator = evaluatorSchema.parse(
    JSON.parse(await readFile(config.evaluatorFile, 'utf8'))
  );
  const bundle = await readFile(
    join(dirname(config.evaluatorFile), 'fixture.mcpb')
  );
  if (
    createHash('sha256').update(bundle).digest('hex') !== evaluator.bundleSha256
  ) {
    throw new Error('Fixture bundle does not match its evaluator file');
  }
  return evaluator;
}

export async function checkConfig(path: string): Promise<CoworkExampleConfig> {
  const config = parseConfig(JSON.parse(await readFile(path, 'utf8')));
  await checkUnused(config);
  await readEvaluator(config);
  return config;
}

export async function checkUnused(config: CoworkExampleConfig): Promise<void> {
  await requireAbsent(config.outputDir);
  await requireAbsent(fixtureReceiptPath(config));
}
