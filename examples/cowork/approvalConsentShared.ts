import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './files.js';
import type { SharedCoworkConfig } from './sharedConfig.js';

const consent = {
  version: 3,
  scope: 'isolated-fixture-automated-approval',
  preSubmit: {
    surface: 'cowork',
    mode: 'automatic',
    scope: 'current_task',
    maxUsesPerCase: 1,
  },
  toolGates: {
    decision: 'allow_once',
    rules: [
      {
        server: 'desktop_records',
        tool: 'lookup_record',
        arguments: { namespace: 'releases' },
        maxUsesPerCase: 2,
      },
      {
        server: 'desktop_records',
        tool: 'search_records',
        arguments: { namespace: 'releases' },
        maxUsesPerCase: 1,
      },
    ],
  },
} as const;

const ConsentSchema = z
  .object({
    version: z.literal(3),
    scope: z.literal('isolated-fixture-automated-approval'),
    preSubmit: z
      .object({
        surface: z.literal('cowork'),
        mode: z.literal('automatic'),
        scope: z.literal('current_task'),
        maxUsesPerCase: z.literal(1),
      })
      .strict(),
    toolGates: z
      .object({
        decision: z.literal('allow_once'),
        rules: z.tuple([
          z
            .object({
              server: z.literal('desktop_records'),
              tool: z.literal('lookup_record'),
              arguments: z
                .object({ namespace: z.literal('releases') })
                .strict(),
              maxUsesPerCase: z.literal(2),
            })
            .strict(),
          z
            .object({
              server: z.literal('desktop_records'),
              tool: z.literal('search_records'),
              arguments: z
                .object({ namespace: z.literal('releases') })
                .strict(),
              maxUsesPerCase: z.literal(1),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export async function authorizeSharedCoworkTools(
  config: SharedCoworkConfig
): Promise<void> {
  const path = consentPath(config);
  try {
    await writePrivateJson(path, consent);
  } catch (error) {
    await assertSharedCoworkToolAuthorization(config);
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
}

export async function assertSharedCoworkToolAuthorization(
  config: SharedCoworkConfig
): Promise<void> {
  const stored = ConsentSchema.parse(
    JSON.parse(await readFile(consentPath(config), 'utf8'))
  );
  if (!isDeepStrictEqual(stored, consent))
    throw new Error('Automated approval consent does not match exactly.');
}

function consentPath(config: SharedCoworkConfig): string {
  return join(
    config.fixtureRoot,
    'evaluator',
    'cowork-automated-approval-consent.json'
  );
}
