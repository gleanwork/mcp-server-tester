import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];
const SNAPSHOT = Symbol.for('leaky-env-plugin.snapshot');
const KEY = 'acme-key-0123456789';

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

/**
 * An eval collected in `leaky/env/unredacted`, whose worker sends back every
 * trial unredacted, quoting the secrets file's `ACME_API_KEY`.
 */
async function leakyEval(caseIds: string[]) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-received-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: caseIds.map((id) => ({
        id,
        input: id,
        assertions: { containsText: 'key' },
      })),
    })
  );
  const secretsFile = path.join(dir, 'secrets.env');
  await fs.writeFile(secretsFile, `ACME_API_KEY=${KEY}\n`);
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'received-redaction',
      plugins: [mock('leakyEnvPlugin.ts'), mock('shardTestPlugin.ts')],
      client: 'shard-test/client/probe',
      datasets: ['./cases.json'],
      // Full traces: the answer is stored too, and a run can be resumed.
      redactStoredResponses: false,
    })
  );
  const outputDir = path.join(dir, 'out');
  return { dir, configPath, outputDir, secretsFile };
}

describe('a trial a worker sends back', () => {
  it('is redacted by the coordinator before it is saved or graded', async () => {
    const f = await leakyEval(['alpha']);
    vi.stubEnv('LEAKY_SNAPSHOT_DIR', f.outputDir);
    const result = await runEval({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      env: 'leaky/env/unredacted',
      secretsFile: f.secretsFile,
      report: false,
    });

    // Saved as each trial arrived, before grading wrote it again.
    const early = (globalThis as Record<symbol, unknown>)[SNAPSHOT];
    expect(early).toContain('the key is [REDACTED]');
    expect(early).not.toContain(KEY);
    const stored = await allText(result.outputDir);
    expect(stored).toContain('the key is [REDACTED]');
    expect(stored).not.toContain(KEY);
  });

  it('is redacted when a resume collects it', async () => {
    const f = await leakyEval(['alpha', 'beta']);
    // The first run never collects beta, so it ends partial.
    vi.stubEnv('LEAKY_SKIP', 'beta');
    const first = await runEval({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      env: 'leaky/env/unredacted',
      secretsFile: f.secretsFile,
      report: false,
    });
    vi.stubEnv('LEAKY_SKIP', '');

    const resumed = await resumeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: path.basename(first.outputDir),
      secretsFile: f.secretsFile,
      report: false,
    });

    const stored = await allText(resumed.outputDir);
    expect(stored).toContain('"beta"');
    expect(stored).toContain('the key is [REDACTED]');
    expect(stored).not.toContain(KEY);
  });
});
