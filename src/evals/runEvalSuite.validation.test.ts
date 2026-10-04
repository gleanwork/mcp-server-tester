import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEvalSuite } from './runEvalSuite.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function dryRun(
  cases: unknown[],
  manifest: Record<string, unknown> = {}
): Promise<unknown> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-validation-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases })
  );
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'validation',
      datasets: ['./cases.json'],
      host: { type: 'vercel-sdk', provider: 'anthropic' },
      ...manifest,
    })
  );
  return runEvalSuite({
    manifestPath: path.join(dir, 'manifest.json'),
    rootDir: dir,
    dryRun: true,
  });
}

describe('a dry run checks datasets too', () => {
  it('rejects a misspelt assertion', async () => {
    await expect(
      dryRun([
        {
          id: 'a',
          mode: 'host',
          scenario: 'Find it',
          expect: { regex: ['found'] },
        },
      ])
    ).rejects.toThrow(/case "a" expect: Unrecognized key: "regex"/);
  });

  it("rejects a case host that can't honour its arm's tool variants, before anything runs", async () => {
    await expect(
      dryRun(
        [
          {
            id: 'cli',
            mode: 'host',
            scenario: 'Find it',
            host: { type: 'claude-cli' },
          },
        ],
        {
          toolOverrides: {
            id: 'v2',
            tools: { search: { description: 'Find it.' } },
          },
        }
      )
    ).rejects.toThrow(
      `Case "cli" in arm "default": host "claude-cli" can't apply toolOverrides`
    );
  });
});
