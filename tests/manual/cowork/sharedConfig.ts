import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { DesktopEvalOracle } from '../../fixtures/desktop-evals/fixture.js';
import { DesktopRuntimeSchema } from '../../fixtures/desktop-evals/contract.js';
import { requireAbsent } from './files.js';

const absolutePath = z
  .string()
  .refine(
    (value) => isAbsolute(value) && !value.includes('REPLACE_ME'),
    'Use an absolute path and replace every REPLACE_ME placeholder'
  );
const server = (label: 'desktop_records' | 'desktop_decoy') =>
  z
    .object({
      transport: z.literal('stdio'),
      label: z.literal(label),
      command: z.string().min(1),
      args: z.tuple([absolutePath, absolutePath]),
    })
    .strict();
export const SharedCoworkConfigSchema = z
  .object({
    attemptId: z.string().regex(/^cowork-shared-[a-z0-9-]+$/),
    runtimePath: absolutePath,
    executablePath: absolutePath,
    profilePath: absolutePath,
    dataDir: absolutePath,
    fixtureRoot: absolutePath,
    outputDir: absolutePath,
    servers: z.tuple([server('desktop_records'), server('desktop_decoy')]),
    approvalServers: z.tuple([
      z
        .object({
          label: z.literal('desktop_records'),
          displayName: z.string().min(1),
        })
        .strict(),
      z
        .object({
          label: z.literal('desktop_decoy'),
          displayName: z.string().min(1),
        })
        .strict(),
    ]),
    mcpServerPrefixes: z
      .record(z.string(), z.enum(['desktop_records', 'desktop_decoy']))
      .refine(
        (prefixes) =>
          Object.keys(prefixes).length === 2 &&
          Object.keys(prefixes).every(
            (prefix) =>
              /^mcp__[A-Za-z0-9_-]+__$/.test(prefix) &&
              !prefix.includes('REPLACE_ME')
          ) &&
          new Set(Object.values(prefixes)).size === 2,
        'Set one verified native prefix for each fixture server'
      ),
  })
  .strict();

export type SharedCoworkConfig = z.infer<typeof SharedCoworkConfigSchema>;

export async function readSharedCoworkConfig(
  path: string
): Promise<SharedCoworkConfig> {
  const config = SharedCoworkConfigSchema.parse(
    JSON.parse(await readFile(path, 'utf8'))
  );
  await requireAbsent(config.outputDir);
  return config;
}

export async function readSharedDesktopOracle(
  fixtureRoot: string
): Promise<DesktopEvalOracle> {
  const evaluator = join(fixtureRoot, 'evaluator');
  const readRuntime = async (label: string) =>
    DesktopRuntimeSchema.parse(
      JSON.parse(
        await readFile(join(evaluator, `${label}.runtime.json`), 'utf8')
      )
    );
  const [primary, decoy] = await Promise.all([
    readRuntime('desktop_records'),
    readRuntime('desktop_decoy'),
  ]);
  if (
    primary.seed.runId !== decoy.seed.runId ||
    primary.seed.serverLabel !== 'desktop_records' ||
    decoy.seed.serverLabel !== 'desktop_decoy' ||
    primary.ledgerPath !== decoy.ledgerPath
  ) {
    throw new Error('Shared desktop fixture provenance is invalid.');
  }
  function byTitle(title: string) {
    const matches = primary.seed.records.filter(
      (record) => record.title.toLowerCase() === title
    );
    if (matches.length !== 1) {
      throw new Error('Shared desktop fixture records are ambiguous.');
    }
    return matches[0]!;
  }
  return {
    runId: primary.seed.runId,
    primary: {
      serverLabel: primary.seed.serverLabel,
      serverName: primary.seed.serverName,
    },
    decoy: {
      serverLabel: decoy.seed.serverLabel,
      serverName: decoy.seed.serverName,
    },
    direct: byTitle('direct release'),
    dependent: byTitle('dependent release'),
    recovery: byTitle('recovery release'),
  };
}

export function sharedLedgerPath(fixtureRoot: string): string {
  return join(fixtureRoot, 'evaluator', 'requests.jsonl');
}
