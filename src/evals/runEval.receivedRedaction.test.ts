import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];
const SNAPSHOT = Symbol.for('leaky-runner-plugin.snapshot');
const KEY = 'acme-key-0123456789';

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
 * An eval collected in `leaky/runner/unredacted`, whose worker sends back every
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
      plugins: [mock('leakyRunnerPlugin.ts'), mock('shardTestPlugin.ts')],
      client: 'shard-test/client/probe',
      datasets: ['./cases.json'],
      // Full transcripts: the answer is stored too, and a run can be resumed.
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
      runner: 'leaky/runner/unredacted',
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

  it('has the connector tokens handed to the worker redacted, on resume too', async () => {
    const f = await leakyEval(['alpha', 'beta']);
    vi.stubEnv('MST_TOKENS_DIR', path.join(f.dir, 'tokens'));
    // A client-credentials grant gives a new token each time: the one this
    // machine starts with, then the one the worker asks for.
    let grants = 0;
    vi.stubGlobal('fetch', async () =>
      Response.json({
        access_token: `connector-token-${++grants}-abcdef`,
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    const connectors: Plugin = {
      meta: { name: 'connector-plugin', namespace: 'notes' },
      connectors: {
        notes: {
          url: 'https://notes.example.test/mcp',
          auth: {
            type: 'client-credentials',
            tokenEndpoint: 'https://auth.example.test/token',
            async client() {
              return { clientId: 'client', clientSecret: 'client-secret' };
            },
          },
        },
      },
    };
    const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    await fs.writeFile(
      f.configPath,
      JSON.stringify({
        ...config,
        servers: { notes: { connector: 'notes/connector/notes' } },
      })
    );

    // The first run never collects beta, so it ends partial.
    vi.stubEnv('LEAKY_SKIP', 'beta');
    const first = await runEval({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      plugins: [connectors],
      runner: 'leaky/runner/unredacted',
      secretsFile: f.secretsFile,
      report: false,
    });
    vi.stubEnv('LEAKY_SKIP', '');
    resetPluginsForTests();
    const resumed = await resumeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: path.basename(first.outputDir),
      plugins: [connectors],
      secretsFile: f.secretsFile,
      report: false,
    });

    // The first run's two grants (this machine's own, the worker's), then
    // the resume's worker's: a resume starts no client here.
    expect(grants).toBe(3);
    const stored = await allText(resumed.outputDir);
    // Each worker got a token and quoted it: alpha's, then beta's on resume.
    for (const caseId of ['alpha', 'beta'])
      expect(
        await fs.readFile(
          path.join(resumed.outputDir, 'transcripts/default', caseId, '0.json'),
          'utf8'
        )
      ).toContain('a token is [REDACTED]');
    expect(stored).not.toContain('connector-token-');
  });

  it('is redacted when a resume collects it', async () => {
    const f = await leakyEval(['alpha', 'beta']);
    // The first run never collects beta, so it ends partial.
    vi.stubEnv('LEAKY_SKIP', 'beta');
    const first = await runEval({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      runner: 'leaky/runner/unredacted',
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
