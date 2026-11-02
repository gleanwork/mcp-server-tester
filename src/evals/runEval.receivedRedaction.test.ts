import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];
const SNAPSHOT = Symbol.for('leaky-env-plugin.snapshot');

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[SNAPSHOT];
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Every file under `dir`, as text. */
async function allText(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')
      )
  );
  return texts.join('\n');
}

describe('a trial a worker sends back', () => {
  it('is redacted by the coordinator before it is saved or graded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-received-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          { id: 'alpha', input: 'alpha', assertions: { containsText: 'key' } },
        ],
      })
    );
    const secretsFile = path.join(dir, 'secrets.env');
    await fs.writeFile(secretsFile, 'ACME_API_KEY=acme-key-0123456789\n');
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'received-redaction',
        plugins: [mock('leakyEnvPlugin.ts'), mock('shardTestPlugin.ts')],
        client: 'shard-test/client/probe',
        datasets: ['./cases.json'],
        // Full traces: the answer is stored too.
        redactStoredResponses: false,
      })
    );

    const outputDir = path.join(dir, 'out');
    vi.stubEnv('LEAKY_SNAPSHOT_DIR', outputDir);
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir,
      env: 'leaky/env/unredacted',
      secretsFile,
      report: false,
    });

    // Saved as each trial arrived, before grading wrote it again.
    const early = (globalThis as Record<symbol, unknown>)[SNAPSHOT];
    expect(early).toContain('the key is [REDACTED]');
    expect(early).not.toContain('acme-key-0123456789');
    const stored = await allText(result.outputDir);
    expect(stored).toContain('the key is [REDACTED]');
    expect(stored).not.toContain('acme-key-0123456789');
  });
});
