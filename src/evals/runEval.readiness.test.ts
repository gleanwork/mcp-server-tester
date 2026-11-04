/**
 * MST's readiness check in a run (ADR 0011): when a server isn't ready, no
 * trial of its batch is sent, and each ends as a retryable setup failure
 * (ADR 0010), locally and on a shard's worker. A resume collects them again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import { READINESS_SERVER } from '../../tests/mocks/readyServers.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** What else a fixture's eval sets. */
interface FixtureOptions {
  /** The client: `shard-test/client/probe` (run per case) by default. */
  client?: string;
  /** Gives the eval tool metadata, so the client gets the servers through the proxy. */
  proxied?: boolean;
  /** How many tools `docs` lists (1 by default). */
  tools?: number;
  /** The `minTools` `docs` declares. */
  minTools?: number;
}

/**
 * Two cases on the shard-test client against `docs`, a stdio server whose
 * first `failLaunches` launches exit before answering.
 */
async function fixture(failLaunches: number, options: FixtureOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-readiness-'));
  dirs.push(dir);
  const launches = path.join(dir, 'launches');
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: ['alpha', 'bravo'].map((id) => ({
        id,
        input: id,
        assertions: { containsText: 'then' },
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'readiness',
      plugins: [mock('forkEnvPlugin.ts'), mock('shardTestPlugin.ts')],
      client: options.client ?? 'shard-test/client/probe',
      datasets: ['./cases.json'],
      ...(options.proxied
        ? { tools: { tool_1: { description: 'The first tool.' } } }
        : {}),
      servers: {
        docs: {
          transport: 'stdio',
          command: process.execPath,
          args: [READINESS_SERVER],
          ...(options.minTools !== undefined
            ? { minTools: options.minTools }
            : {}),
          env: {
            READINESS_FAIL_FILE: launches,
            READINESS_FAIL_TIMES: String(failLaunches),
            READINESS_TOOLS: String(options.tools ?? 1),
          },
        },
      },
      variants: [{ name: 'baseline', servers: ['docs'] }],
      redactStoredResponses: false,
    })
  );
  const outputDir = path.join(dir, 'out');
  const trial = async (runDir: string, caseId: string) =>
    JSON.parse(
      await fs.readFile(
        path.join(runDir, 'traces', 'baseline', caseId, '0.json'),
        'utf8'
      )
    ) as { ending?: unknown; error?: string; infrastructureError?: boolean };
  return {
    launches: async () =>
      (await fs.readFile(launches, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean).length,
    trial,
    run: (env?: string) =>
      runEval({
        configPath,
        rootDir: dir,
        outputDir,
        ...(env ? { env, envOptions: { shards: '1' } } : {}),
      }),
    resume: (run: string) =>
      resumeRun({
        configPath,
        rootDir: dir,
        outputDir,
        run,
        envOptions: { shards: '1' },
      }),
  };
}

const notReady =
  /^MCP server not ready, so no trial was sent: docs did not connect \(.+\)\. Checked 1 time\.$/;

describe('the retry setting', () => {
  it('fails a run that sets the retired MST_COWORK_MCP_PREFLIGHT_RETRY_S when it starts, naming the new name', async () => {
    vi.stubEnv('MST_COWORK_MCP_PREFLIGHT_RETRY_S', '10,30');
    const f = await fixture(0);
    await expect(f.run()).rejects.toThrow(
      "MST_COWORK_MCP_PREFLIGHT_RETRY_S was renamed: MST now checks every client's MCP servers before the first trial. Set MST_MCP_READINESS_RETRY_S instead."
    );
    // Before any trial: not even the check ran.
    expect(await f.launches()).toBe(0);
  });
});

describe('a run whose server is not ready', () => {
  it('ends every trial of the batch as a retryable setup failure, locally', async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture(99);
    const result = await f.run();
    expect(result.summary.metrics).toMatchObject({
      passed: 0,
      failed: 0,
      incomplete: 2,
    });
    for (const caseId of ['alpha', 'bravo']) {
      const stored = await f.trial(result.outputDir, caseId);
      expect(stored).toMatchObject({
        infrastructureError: true,
        ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
      });
      expect(stored.error).toMatch(notReady);
    }
    // One check for the batch.
    expect(await f.launches()).toBe(1);
  }, 30_000);

  it('does the same on a worker, and a resume collects the trials again', async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The worker's one check fails; the resume's passes.
    const f = await fixture(1);
    const first = await f.run('fork/env/children');
    expect(first.summary.metrics).toMatchObject({
      passed: 0,
      failed: 0,
      incomplete: 2,
    });
    for (const caseId of ['alpha', 'bravo']) {
      const stored = await f.trial(first.outputDir, caseId);
      expect(stored).toMatchObject({
        infrastructureError: true,
        ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
      });
      expect(stored.error).toMatch(notReady);
    }
    expect(await f.launches()).toBe(1);

    const resumed = await f.resume(path.basename(first.outputDir));
    expect(resumed.summary.metrics).toMatchObject({ passed: 2, total: 2 });
    expect(resumed.summary.metrics).not.toHaveProperty('incomplete');
    expect(await f.launches()).toBe(2);
  }, 90_000);
});

/**
 * A variant with tool metadata reaches the client through MST's
 * tool-variant proxy. The rule is the same: its servers are checked as
 * declared, before the proxy starts, with retries.
 */
describe('a proxied run whose server is not ready', () => {
  async function expectSetupEndings(
    f: Awaited<ReturnType<typeof fixture>>,
    runDir: string,
    reason: RegExp
  ) {
    for (const caseId of ['alpha', 'bravo']) {
      const stored = await f.trial(runDir, caseId);
      expect(stored).toMatchObject({
        infrastructureError: true,
        ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
      });
      expect(stored.error).toMatch(reason);
    }
  }

  it.each(['shard-test/client/probe', 'shard-test/client/batch'])(
    'ends every trial of a %s batch as a retryable setup failure, after the retries, locally',
    async (client) => {
      vi.stubEnv('MST_MCP_READINESS_RETRY_S', '0,0');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = await fixture(99, { client, proxied: true });
      const result = await f.run();
      expect(result.summary.metrics).toMatchObject({
        passed: 0,
        failed: 0,
        incomplete: 2,
      });
      await expectSetupEndings(
        f,
        result.outputDir,
        /^MCP server not ready, so no trial was sent: docs did not connect \(.+\)\. Checked 3 times\.$/
      );
      // Checked three times; the proxy never started.
      expect(await f.launches()).toBe(3);
    },
    30_000
  );

  it.each(['shard-test/client/probe', 'shard-test/client/batch'])(
    "holds a %s batch to its server's minTools",
    async (client) => {
      vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = await fixture(0, { client, proxied: true, minTools: 2 });
      const result = await f.run();
      expect(result.summary.metrics).toMatchObject({ incomplete: 2 });
      await expectSetupEndings(
        f,
        result.outputDir,
        /^MCP server not ready, so no trial was sent: docs listed 1 tool, fewer than its minTools \(2\)\. Checked 1 time\.$/
      );
    },
    30_000
  );

  it('does the same on a worker, minTools included', async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await fixture(99, { proxied: true });
    const first = await down.run('fork/env/children');
    expect(first.summary.metrics).toMatchObject({ incomplete: 2 });
    await expectSetupEndings(down, first.outputDir, notReady);

    const degraded = await fixture(0, { proxied: true, minTools: 2 });
    const second = await degraded.run('fork/env/children');
    expect(second.summary.metrics).toMatchObject({ incomplete: 2 });
    await expectSetupEndings(
      degraded,
      second.outputDir,
      /^MCP server not ready, so no trial was sent: docs listed 1 tool, fewer than its minTools \(2\)\. Checked 1 time\.$/
    );
  }, 90_000);
});
