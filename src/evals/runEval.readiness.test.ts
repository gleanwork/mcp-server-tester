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
  /** Every launch of `docs` after the first `failAfter` exits before answering. */
  failAfter?: number;
  /** Only the launch of `docs` at this index (from 0) exits before answering. */
  failLaunch?: number;
  /** Adds a second dataset, `more` (cases `charlie` and `delta`), its own batch. */
  secondDataset?: boolean;
  /**
   * Gives `docs` a client-resolved field (`${dataDir}`), so MST's check
   * leaves it to the client and never reads the retry setting.
   */
  clientResolved?: boolean;
}

/**
 * Two cases on the shard-test client against `docs`, a stdio server whose
 * first `failLaunches` launches exit before answering.
 */
async function fixture(failLaunches: number, options: FixtureOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-readiness-'));
  dirs.push(dir);
  const launches = path.join(dir, 'launches');
  const writeDataset = (file: string, name: string, ids: string[]) =>
    fs.writeFile(
      path.join(dir, file),
      JSON.stringify({
        name,
        cases: ids.map((id) => ({
          id,
          input: id,
          assertions: { containsText: 'then' },
        })),
      })
    );
  await writeDataset('cases.json', 'cases', ['alpha', 'bravo']);
  if (options.secondDataset)
    await writeDataset('more.json', 'more', ['charlie', 'delta']);
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'readiness',
      plugins: [mock('forkRunnerPlugin.ts'), mock('shardTestPlugin.ts')],
      client: options.client ?? 'shard-test/client/probe',
      datasets: options.secondDataset
        ? ['./cases.json', './more.json']
        : ['./cases.json'],
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
            ...(options.failAfter !== undefined
              ? { READINESS_FAIL_AFTER: String(options.failAfter) }
              : {}),
            ...(options.failLaunch !== undefined
              ? { READINESS_FAIL_LAUNCH: String(options.failLaunch) }
              : {}),
            ...(options.clientResolved
              ? { READINESS_DATA_DIR: '${dataDir}' }
              : {}),
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
        path.join(runDir, 'transcripts', 'baseline', caseId, '0.json'),
        'utf8'
      )
    ) as { ending?: unknown; error?: string; infrastructureError?: boolean };
  return {
    configPath,
    launches: async () =>
      (await fs.readFile(launches, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean).length,
    trial,
    run: (runner?: string, runnerOptions: Record<string, string> = {}) =>
      runEval({
        configPath,
        rootDir: dir,
        outputDir,
        ...(runner
          ? { runner, runnerOptions: { shards: '1', ...runnerOptions } }
          : {}),
      }),
    resume: (run: string) =>
      resumeRun({
        configPath,
        rootDir: dir,
        outputDir,
        run,
        runnerOptions: { shards: '1' },
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

  // Only the worker's environment holds the setting, so the coordinator's
  // own check passes and the worker must catch it. Its batch's server is
  // left to the client, so no check before a trial would read it either.
  it.each([
    {
      setting: 'a malformed MST_MCP_READINESS_RETRY_S',
      workerEnv: { MST_MCP_READINESS_RETRY_S: 'soon' },
      message:
        'MST_MCP_READINESS_RETRY_S must be comma-separated seconds, got "soon"',
    },
    {
      setting: 'the retired MST_COWORK_MCP_PREFLIGHT_RETRY_S',
      workerEnv: { MST_COWORK_MCP_PREFLIGHT_RETRY_S: '10,30' },
      message:
        "MST_COWORK_MCP_PREFLIGHT_RETRY_S was renamed: MST now checks every client's MCP servers before the first trial. Set MST_MCP_READINESS_RETRY_S instead.",
    },
  ])(
    'fails the shard of a worker whose environment sets $setting, before any launch or trial',
    async ({ workerEnv, message }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = await fixture(0, { clientResolved: true });
      // The client marks each trial it runs here.
      const marks = path.join(path.dirname(f.configPath), 'marks.log');
      vi.stubEnv('SHARD_TEST_LOG', marks);
      const result = await f.run('fork/runner/children', {
        workerEnv: JSON.stringify(workerEnv),
      });
      expect(result.summary.metrics).toMatchObject({
        total: 0,
        incomplete: 2,
      });
      for (const caseId of ['alpha', 'bravo']) {
        const stored = await f.trial(result.outputDir, caseId);
        expect(stored).toMatchObject({
          infrastructureError: true,
          ending: { kind: 'infrastructure', broke: 'collection' },
        });
        expect(stored.error).toContain(message);
      }
      // No server launched, not even for the check, and no trial ran.
      expect(await f.launches()).toBe(0);
      await expect(fs.readFile(marks, 'utf8')).rejects.toThrow();
    },
    90_000
  );
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
    const first = await f.run('fork/runner/children');
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

  /**
   * The check passes (the first launch of `docs`), and the proxy's own
   * connection to it (the second) fails.
   */
  const proxyNotReady =
    /^MCP server not ready, so no trial was sent: docs did not connect \(.+\) when the tool-variant proxy started\.$/;

  it.each(['shard-test/client/probe', 'shard-test/client/batch'])(
    'ends every trial of a %s batch as a retryable setup failure when the proxy cannot reach a server that passed the check, locally',
    async (client) => {
      vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = await fixture(0, { client, proxied: true, failAfter: 1 });
      // The client marks each trial it runs here.
      const marks = path.join(path.dirname(f.configPath), 'marks.log');
      vi.stubEnv('SHARD_TEST_LOG', marks);
      const result = await f.run();
      expect(result.summary.metrics).toMatchObject({
        passed: 0,
        failed: 0,
        incomplete: 2,
      });
      await expectSetupEndings(f, result.outputDir, proxyNotReady);
      // One check, one proxy start; the client never ran.
      expect(await f.launches()).toBe(2);
      await expect(fs.readFile(marks, 'utf8')).rejects.toThrow();
    },
    30_000
  );

  it("starts the proxy again for the variant's next batch after its start failed", async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Launches: the first batch's check (0) passes and its proxy start (1)
    // fails; the second batch's check (2) and proxy start (3) succeed.
    const f = await fixture(0, {
      proxied: true,
      failLaunch: 1,
      secondDataset: true,
    });
    const result = await f.run();
    // The second batch's trials ran. They fail because this client never
    // lists the tools the proxy serves it.
    expect(result.summary.metrics).toMatchObject({
      passed: 0,
      failed: 2,
      incomplete: 2,
    });
    await expectSetupEndings(f, result.outputDir, proxyNotReady);
    for (const caseId of ['charlie', 'delta'])
      expect(await f.trial(result.outputDir, caseId)).toMatchObject({
        infrastructureError: false,
        ending: { kind: 'trial' },
        error: expect.stringContaining("didn't see tool variant"),
      });
    expect(await f.launches()).toBe(4);
  }, 30_000);

  it('does the same on a worker when the proxy cannot reach a server that passed the check', async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture(0, { proxied: true, failAfter: 1 });
    const result = await f.run('fork/runner/children');
    expect(result.summary.metrics).toMatchObject({
      passed: 0,
      failed: 0,
      incomplete: 2,
    });
    await expectSetupEndings(f, result.outputDir, proxyNotReady);
    expect(await f.launches()).toBe(2);
  }, 90_000);

  it('does the same on a worker, minTools included', async () => {
    vi.stubEnv('MST_MCP_READINESS_RETRY_S', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await fixture(99, { proxied: true });
    const first = await down.run('fork/runner/children');
    expect(first.summary.metrics).toMatchObject({ incomplete: 2 });
    await expectSetupEndings(down, first.outputDir, notReady);

    const degraded = await fixture(0, { proxied: true, minTools: 2 });
    const second = await degraded.run('fork/runner/children');
    expect(second.summary.metrics).toMatchObject({ incomplete: 2 });
    await expectSetupEndings(
      degraded,
      second.outputDir,
      /^MCP server not ready, so no trial was sent: docs listed 1 tool, fewer than its minTools \(2\)\. Checked 1 time\.$/
    );
  }, 90_000);
});
