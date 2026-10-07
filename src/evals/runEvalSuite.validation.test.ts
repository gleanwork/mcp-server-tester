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
  evalConfig: Record<string, unknown> = {}
): Promise<unknown> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-validation-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'validation',
      datasets: ['./cases.json'],
      client: 'mst',
      clientOptions: { provider: 'anthropic' },
      ...evalConfig,
    })
  );
  return runEvalSuite({
    configPath: path.join(dir, 'eval.json'),
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
          input: 'Find it',
          assertions: { regex: ['found'] },
        },
      ])
    ).rejects.toThrow(/case "a" assertions: Unrecognized key: "regex"/);
  });

  it("rejects a case client that can't show its variant's tool metadata, before anything runs", async () => {
    await expect(
      dryRun(
        [
          {
            id: 'desktop',
            input: 'Find it',
            client: 'chatgpt',
            model: 'gpt-5',
          },
        ],
        {
          tools: { search: { description: 'Find it.' } },
        }
      )
    ).rejects.toThrow(
      `Case "desktop" in variant "default": client "chatgpt" can't show tool metadata`
    );
  });
});

describe('a case systemPrompt', () => {
  it("rejects one under a client that can't apply it", async () => {
    await expect(
      dryRun(
        [
          {
            id: 'org',
            input: 'Find it',
            clientOptions: { systemPrompt: 'Case prompt.' },
          },
        ],
        { client: 'cowork' }
      )
    ).rejects.toThrow(/systemPrompt/);
  });
});
