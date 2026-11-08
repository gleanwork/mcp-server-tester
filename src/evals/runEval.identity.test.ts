/**
 * What run.json records so an eval's history can tell two runs had the same
 * setup: options hashed under the eval's key, and the plugins it loaded.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { RunRecord } from './runFormat.js';

const dirs: string[] = [];
afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const plugin: Plugin = {
  meta: { name: '@acme/mst-plugin', namespace: 'acme', version: '1.2.3' },
  clients: {
    echo: {
      schema: z.object({ type: z.string(), apiToken: z.string() }).strict(),
      evidence: 'structured',
      run: async () => ({ finalText: 'answer', events: [] }),
    },
  },
};

async function writeEval(dir: string, apiToken: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases: [{ id: 'a', input: 'Hi?' }] })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'identity',
      datasets: ['./cases.json'],
      client: 'acme/client/echo',
      clientOptions: { apiToken },
    })
  );
}

async function runRecord(dir: string): Promise<RunRecord> {
  const { outputDir } = await runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
  });
  return JSON.parse(
    await fs.readFile(path.join(outputDir, 'run.json'), 'utf8')
  ) as RunRecord;
}

describe("run.json's setup identity", () => {
  it("hashes a secret option the same in the eval's runs, and records the plugins", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-identity-'));
    dirs.push(dir);
    await writeEval(dir, 'secret-token-1');
    const first = await runRecord(dir);
    const second = await runRecord(dir);
    const token = (record: RunRecord) =>
      record.variants[0]!.clientOptions?.apiToken;
    expect(token(first)).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(JSON.stringify(first)).not.toContain('secret-token-1');
    expect(token(second)).toBe(token(first));
    await writeEval(dir, 'secret-token-2');
    expect(token(await runRecord(dir))).not.toBe(token(first));
    expect(first.plugins).toEqual([
      { namespace: 'acme', name: '@acme/mst-plugin', version: '1.2.3' },
    ]);
  });
});
