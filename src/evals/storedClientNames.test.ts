/**
 * A run stored before the `mst` client was renamed `api` (ADR 0011) says
 * `client: "mst"`, and one stored before the Codex surface became the
 * `codex-app` client says `client: "chatgpt"` with `clientOptions.surface:
 * "codex"`. Their files keep those names; every reader sees the current
 * client, so the run still grades, resumes and reports.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeRun, resumeRun, runEval } from './runEval.js';
import {
  readRunDirectory,
  runWithCurrentClients,
  summaryWithCurrentClients,
  type RunRecord,
} from './runFormat.js';
import { buildRunReport } from './runReport.js';
import { storedRunTraces } from './telemetry/runTraces.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import { simulateMstClient } from './mstClient/simulation.js';
import {
  openToolOptimization,
  startToolOptimization,
} from './storedOptimization.js';
import { findPreviousRun } from './runBaseline.js';
import { fileRunStore, storeRunHistory, uploadRun } from './runStore.js';
import { storedClientSetup } from './clientNames.js';
import { getClient } from './builtinClients.js';

// The api client's model: it answers without calling a tool.
vi.mock('./mstClient/simulation.js', () => ({ simulateMstClient: vi.fn() }));

const FIXTURES = fileURLToPath(
  new URL('../../tests/usecases/fixtures', import.meta.url)
);

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

const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2));

/**
 * An eval on the api client, collected in `leaky/env/unredacted`, whose
 * worker answers every trial itself, so no model runs. A case in `skip`
 * isn't collected, and the run ends partial. The stored run's files are then
 * rewritten as MST wrote them before the rename: every client is `mst`.
 */
async function runStoredAsMst(caseIds: string[], skip?: string) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-stored-client-'));
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
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'stored-client',
      plugins: [mock('leakyEnvPlugin.ts')],
      client: 'api',
      model: 'claude-haiku-4-5',
      datasets: ['./cases.json'],
      servers: {},
      // Full traces, so the run can be graded again and resumed.
      redactStoredResponses: false,
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
    })
  );
  const outputDir = path.join(dir, 'out');
  vi.stubEnv('LEAKY_SKIP', skip ?? '');
  const collected = await runEval({
    configPath,
    rootDir: dir,
    outputDir,
    env: 'leaky/env/unredacted',
    report: false,
  });
  vi.stubEnv('LEAKY_SKIP', '');
  const runDir = collected.outputDir;

  const runFile = path.join(runDir, 'run.json');
  const run = await readJson(runFile);
  const variants = run.variants as Array<{ client?: string }>;
  expect(variants.map((variant) => variant.client)).toEqual(['api', 'api']);
  for (const variant of variants) variant.client = 'mst';
  await writeJson(runFile, run);
  const resultsFile = path.join(runDir, 'results.json');
  const results = await readJson(resultsFile);
  const cases = results.cases as Array<{ request?: { client?: string } }>;
  expect(cases.length).toBeGreaterThan(0);
  for (const result of cases) {
    expect(result.request?.client).toBe('api');
    result.request!.client = 'mst';
  }
  await writeJson(resultsFile, results);

  return {
    dir,
    configPath,
    outputDir,
    runDir,
    runId: path.basename(runDir),
    metrics: collected.summary.metrics,
    results: collected.summary.results,
  };
}

/** Every client a run's files name, in run.json and results.json. */
async function storedClients(runDir: string): Promise<string[]> {
  const run = await readJson(path.join(runDir, 'run.json'));
  const results = await readJson(path.join(runDir, 'results.json'));
  return [
    ...(run.variants as Array<{ client?: string }>).map((v) => v.client),
    ...(results.cases as Array<{ request?: { client?: string } }>).map(
      (r) => r.request?.client
    ),
  ].filter((client): client is string => client !== undefined);
}

describe('a run stored when the api client was mst', () => {
  it('is read as api, without rewriting its files', async () => {
    const f = await runStoredAsMst(['alpha']);

    const stored = await readRunDirectory(f.runDir);
    expect(stored.run.variants.map((variant) => variant.client)).toEqual([
      'api',
      'api',
    ]);
    expect(
      stored.summary.results.map((result) => result.request?.client)
    ).toEqual(['api', 'api']);
    expect(
      stored.summary.variants.flatMap(
        (variant) =>
          variant.result?.caseResults.map((r) => r.request?.client) ?? []
      )
    ).toEqual(['api', 'api']);
    // The report (`mst open`, `mst label`) and the traces it sends.
    expect(
      buildRunReport(stored).variants.map((variant) => variant.client)
    ).toEqual(['api', 'api']);
    const traces = JSON.stringify(storedRunTraces(stored));
    expect(traces).toContain('"invoke_agent api"');
    expect(traces).not.toContain('"invoke_agent mst"');
    // The files keep the name they were written with.
    expect(await storedClients(f.runDir)).toEqual(['mst', 'mst', 'mst', 'mst']);
  });

  it('grades again with mst grade', async () => {
    const f = await runStoredAsMst(['alpha', 'bravo']);

    const regrade = await gradeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: f.runId,
      report: false,
    });

    expect(regrade.gradedFrom).toBe(f.runId);
    // Graded as when it was collected: the worker's answers carry an error.
    expect(regrade.summary.metrics).toMatchObject({
      total: 4,
      passed: f.metrics.passed,
      failed: f.metrics.failed,
    });
    expect(
      regrade.summary.results.map((result) => result.request?.client)
    ).toEqual(['api', 'api', 'api', 'api']);
    expect(await storedClients(regrade.outputDir)).toEqual(
      Array(6).fill('api')
    );
    // The run it graded is unchanged.
    expect(await storedClients(f.runDir)).toEqual(Array(6).fill('mst'));
  });

  it('collects its missing trials with mst run --resume', async () => {
    const f = await runStoredAsMst(['alpha', 'bravo'], 'bravo');

    const resumed = await resumeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: f.runId,
      report: false,
    });

    expect(path.basename(resumed.outputDir)).toBe(f.runId);
    // Bravo was missing; now every trial is collected.
    const missing = (results: Array<{ error?: string }>) =>
      results.filter((result) => result.error?.startsWith('Missing')).length;
    expect(missing(f.results)).toBe(2);
    expect(resumed.summary.results).toHaveLength(4);
    expect(missing(resumed.summary.results)).toBe(0);
    expect(
      resumed.summary.results.map((result) => result.request?.client)
    ).toEqual(['api', 'api', 'api', 'api']);
    expect(await storedClients(resumed.outputDir)).toEqual(
      Array(6).fill('api')
    );
  });
});

describe('a tool optimization whose baseline was stored with mst', () => {
  it("runs a round on api: the base variant's client didn't change", async () => {
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: true,
      response: 'No idea.',
      toolCalls: [],
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-stored-opt-'));
    dirs.push(dir);
    const catalog = path.join(dir, 'docs.json');
    await fs.copyFile(path.join(FIXTURES, 'catalogs', 'docs.json'), catalog);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'triggering',
        cases: [
          ...[0, 1, 2].map((i) => ({
            id: `case-${i}`,
            input: `Find what we know about outage ${i}`,
            assertions: {
              toolsTriggered: { calls: [{ name: 'search', required: true }] },
            },
          })),
          {
            id: 'no-search',
            input: 'Say hello',
            tags: ['regression'],
            assertions: { toolCallCount: { max: 0 } },
          },
        ],
      })
    );
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'stored-client-optimization',
        datasets: ['./cases.json'],
        servers: {
          docs: {
            transport: 'stdio',
            command: process.execPath,
            args: [path.join(FIXTURES, 'catalogServer.mjs'), catalog],
          },
        },
        client: 'api',
        model: 'claude-haiku-4-5',
      })
    );
    const target = { configPath, rootDir: dir };
    const started = await startToolOptimization({ evalConfig: target });
    const baselineFile = path.join(
      started.evalDirectory,
      'runs',
      started.record.baseline.runId,
      'run.json'
    );
    const baseline = await readJson(baselineFile);
    const variants = baseline.variants as Array<{ client?: string }>;
    expect(variants.map((variant) => variant.client)).toEqual(['api']);
    variants[0]!.client = 'mst';
    await writeJson(baselineFile, baseline);

    // Another process reads the baseline from its files.
    const reopened = await openToolOptimization({ evalConfig: target });
    const { round } = await reopened.tryCandidates([
      { id: 'concise', tools: { search: { description: 'Search.' } } },
    ]);
    expect(round.candidates.map((c) => c.variant.id)).toEqual(['concise']);
  }, 120_000);
});

/**
 * As runStoredAsMst, on the codex-app client, with each variant's client
 * options; the stored run's files are then rewritten as MST wrote them
 * before codex-app: `chatgpt` with `surface: "codex"` in run.json's
 * variants and `chatgpt` in its results. (The leaky environment's shard
 * reports no client; runWithCurrentClients' own tests cover a machine's.)
 */
async function runStoredAsChatgptCodex(caseIds: string[], skip?: string) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-stored-codex-'));
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
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'stored-codex-app',
      plugins: [mock('leakyEnvPlugin.ts')],
      client: 'codex-app',
      model: 'gpt-test',
      datasets: ['./cases.json'],
      servers: {},
      redactStoredResponses: false,
      variants: [
        { name: 'baseline' },
        { name: 'candidate', clientOptions: { requireMcpCalls: true } },
      ],
    })
  );
  const outputDir = path.join(dir, 'out');
  vi.stubEnv('LEAKY_SKIP', skip ?? '');
  const collected = await runEval({
    configPath,
    rootDir: dir,
    outputDir,
    env: 'leaky/env/unredacted',
    report: false,
  });
  vi.stubEnv('LEAKY_SKIP', '');
  const runDir = collected.outputDir;

  const runFile = path.join(runDir, 'run.json');
  const run = await readJson(runFile);
  const variants = run.variants as Array<{
    client?: string;
    clientOptions?: Record<string, unknown>;
  }>;
  expect(variants.map((variant) => variant.client)).toEqual([
    'codex-app',
    'codex-app',
  ]);
  // As run.json records them: parsed, with the client's defaults.
  const recordedOptions = structuredClone(
    variants.map((variant) => variant.clientOptions)
  );
  expect(recordedOptions[0]).not.toHaveProperty('requireMcpCalls');
  expect(recordedOptions[1]).toMatchObject({ requireMcpCalls: true });
  expect(recordedOptions[0]).not.toHaveProperty('surface');
  for (const variant of variants) {
    variant.client = 'chatgpt';
    variant.clientOptions = { ...variant.clientOptions, surface: 'codex' };
  }
  await writeJson(runFile, run);
  const resultsFile = path.join(runDir, 'results.json');
  const results = await readJson(resultsFile);
  const cases = results.cases as Array<{ request?: { client?: string } }>;
  expect(cases.length).toBeGreaterThan(0);
  for (const result of cases) {
    expect(result.request?.client).toBe('codex-app');
    result.request!.client = 'chatgpt';
  }
  await writeJson(resultsFile, results);

  return {
    dir,
    configPath,
    outputDir,
    runDir,
    runId: path.basename(runDir),
    configId: collected.summary.configId,
    recordedOptions,
    results: collected.summary.results,
  };
}

describe('a run stored when codex-app was chatgpt with the Codex surface', () => {
  it('is read as codex-app, without surface and without rewriting its files', async () => {
    const f = await runStoredAsChatgptCodex(['alpha']);

    const stored = await readRunDirectory(f.runDir);
    expect(
      stored.run.variants.map(({ name, client, clientOptions }) => ({
        name,
        client,
        clientOptions,
      }))
    ).toEqual([
      {
        name: 'baseline',
        client: 'codex-app',
        clientOptions: f.recordedOptions[0],
      },
      {
        name: 'candidate',
        client: 'codex-app',
        clientOptions: f.recordedOptions[1],
      },
    ]);
    expect(
      stored.summary.results.map((result) => result.request?.client)
    ).toEqual(['codex-app', 'codex-app']);
    expect(
      stored.summary.variants.flatMap(
        (variant) =>
          variant.result?.caseResults.map((r) => r.request?.client) ?? []
      )
    ).toEqual(['codex-app', 'codex-app']);
    // The report (`mst open`, `mst label`) and the traces it sends.
    const report = buildRunReport(stored);
    expect(report.variants.map((variant) => variant.client)).toEqual([
      'codex-app',
      'codex-app',
    ]);
    expect(JSON.stringify(report)).not.toContain('surface');
    const traces = JSON.stringify(storedRunTraces(stored));
    expect(traces).toContain('"invoke_agent codex-app"');
    expect(traces).not.toContain('"invoke_agent chatgpt"');
    // storedRunTraces maps a run it is given as stored, too.
    const raw = {
      ...stored,
      run: {
        ...stored.run,
        variants: stored.run.variants.map((variant) => ({
          ...variant,
          client: 'chatgpt',
          clientOptions: { surface: 'codex' },
        })),
      },
    };
    expect(JSON.stringify(storedRunTraces(raw))).toContain(
      '"invoke_agent codex-app"'
    );
    // The files keep the name and options they were written with.
    expect(await storedClients(f.runDir)).toEqual(Array(4).fill('chatgpt'));
    const run = await readJson(path.join(f.runDir, 'run.json'));
    expect(
      (run.variants as Array<{ clientOptions?: unknown }>).map(
        (variant) => variant.clientOptions
      )
    ).toEqual(
      f.recordedOptions.map((options) => ({ ...options, surface: 'codex' }))
    );
  });

  it('grades again with mst grade', async () => {
    const f = await runStoredAsChatgptCodex(['alpha', 'bravo']);

    const regrade = await gradeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: f.runId,
      report: false,
    });

    expect(regrade.gradedFrom).toBe(f.runId);
    expect(
      regrade.summary.results.map((result) => result.request?.client)
    ).toEqual(Array(4).fill('codex-app'));
    expect(await storedClients(regrade.outputDir)).toEqual(
      Array(6).fill('codex-app')
    );
    expect(await storedClients(f.runDir)).toEqual(Array(6).fill('chatgpt'));
  });

  it('collects its missing trials with mst run --resume', async () => {
    const f = await runStoredAsChatgptCodex(['alpha', 'bravo'], 'bravo');

    const resumed = await resumeRun({
      configPath: f.configPath,
      rootDir: f.dir,
      outputDir: f.outputDir,
      run: f.runId,
      report: false,
    });

    expect(path.basename(resumed.outputDir)).toBe(f.runId);
    expect(resumed.summary.results).toHaveLength(4);
    expect(
      resumed.summary.results.map((result) => result.request?.client)
    ).toEqual(Array(4).fill('codex-app'));
    expect(await storedClients(resumed.outputDir)).toEqual(
      Array(6).fill('codex-app')
    );
  });

  it('is the previous run, with its cases on codex-app, from runs/ and from a result store', async () => {
    const f = await runStoredAsChatgptCodex(['alpha']);
    const search = {
      configId: f.configId,
      runId: '20991231T000000Z-000000',
      variants: ['baseline', 'candidate'],
      outputRoot: path.dirname(f.runDir),
    };
    const store = fileRunStore(path.join(f.dir, 'store'));
    await uploadRun(store, {
      evalName: 'stored-codex-app',
      runId: f.runId,
      runDirectory: f.runDir,
    });
    for (const previous of [
      await findPreviousRun(search),
      await findPreviousRun({
        ...search,
        history: storeRunHistory(store, 'stored-codex-app'),
      }),
    ]) {
      expect(previous?.runId).toBe(f.runId);
      expect(
        previous?.summary.results.map((result) => result.request?.client)
      ).toEqual(['codex-app', 'codex-app']);
      expect(
        previous?.summary.variants.flatMap(
          (variant) =>
            variant.result?.caseResults.map((r) => r.request?.client) ?? []
        )
      ).toEqual(['codex-app', 'codex-app']);
    }
  });
});

describe('a tool optimization whose baseline was stored as chatgpt with the Codex surface', () => {
  it("runs a round on codex-app: the base variant's client and options didn't change", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // codex-app can't show tool metadata, so no real round runs on it; here
    // it can, so the baseline's setup is what the round is checked against.
    // The leaky environment answers every trial, so no app runs.
    const definition = getClient('codex-app') as { toolMetadata?: boolean };
    const toolMetadata = definition.toolMetadata;
    definition.toolMetadata = true;
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-stored-opt-'));
      dirs.push(dir);
      const catalog = path.join(dir, 'docs.json');
      await fs.copyFile(path.join(FIXTURES, 'catalogs', 'docs.json'), catalog);
      await fs.writeFile(
        path.join(dir, 'cases.json'),
        JSON.stringify({
          name: 'triggering',
          cases: [
            ...[0, 1, 2].map((i) => ({
              id: `case-${i}`,
              input: `Find what we know about outage ${i}`,
              assertions: { containsText: 'outage' },
            })),
            {
              id: 'no-search',
              input: 'Say hello',
              tags: ['regression'],
              assertions: { containsText: 'hello' },
            },
          ],
        })
      );
      const configPath = path.join(dir, 'eval.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          name: 'stored-codex-optimization',
          plugins: [mock('leakyEnvPlugin.ts')],
          datasets: ['./cases.json'],
          servers: {
            docs: {
              transport: 'stdio',
              command: process.execPath,
              args: [path.join(FIXTURES, 'catalogServer.mjs'), catalog],
            },
          },
          client: 'codex-app',
          model: 'gpt-test',
          clientOptions: { requireMcpCalls: true },
        })
      );
      const target = {
        configPath,
        rootDir: dir,
        env: 'leaky/env/unredacted',
      };
      const started = await startToolOptimization({ evalConfig: target });
      const baselineFile = path.join(
        started.evalDirectory,
        'runs',
        started.record.baseline.runId,
        'run.json'
      );
      const baseline = await readJson(baselineFile);
      const variants = baseline.variants as Array<{
        client?: string;
        clientOptions?: Record<string, unknown>;
      }>;
      expect(
        variants.map(({ client, clientOptions }) => ({ client, clientOptions }))
      ).toEqual([
        {
          client: 'codex-app',
          clientOptions: expect.objectContaining({ requireMcpCalls: true }),
        },
      ]);
      variants[0]!.client = 'chatgpt';
      variants[0]!.clientOptions = {
        ...variants[0]!.clientOptions,
        surface: 'codex',
      };
      await writeJson(baselineFile, baseline);

      // Another process reads the baseline from its files.
      const reopened = await openToolOptimization({ evalConfig: target });
      const { round } = await reopened.tryCandidates([
        { id: 'concise', tools: { search: { description: 'Search.' } } },
      ]);
      expect(round.candidates.map((c) => c.variant.id)).toEqual(['concise']);
    } finally {
      definition.toolMetadata = toolMetadata;
    }
  }, 120_000);
});

describe('storedClientSetup', () => {
  it('reads chatgpt with the Codex surface as codex-app, and drops surface', () => {
    expect(
      storedClientSetup({
        name: 'v',
        client: 'chatgpt',
        clientOptions: { surface: 'codex' },
      })
    ).toEqual({ name: 'v', client: 'codex-app' });
    expect(
      storedClientSetup({
        client: 'mst/client/chatgpt',
        clientOptions: { surface: 'codex', requireMcpCalls: true },
      })
    ).toEqual({
      client: 'codex-app',
      clientOptions: { requireMcpCalls: true },
    });
    // ChatGPT Work was what chatgpt always does.
    expect(
      storedClientSetup({
        client: 'chatgpt',
        clientOptions: { surface: 'chatgpt-work', timeout: 1 },
      })
    ).toEqual({ client: 'chatgpt', clientOptions: { timeout: 1 } });
  });

  it('leaves a plain chatgpt, and other clients, as they were', () => {
    const plain = { client: 'chatgpt', clientOptions: { timeout: 1 } };
    expect(storedClientSetup(plain)).toBe(plain);
    expect(storedClientSetup({ client: 'chatgpt' })).toEqual({
      client: 'chatgpt',
    });
    // Only chatgpt had the option.
    const plugin = {
      client: 'acme/client/desk',
      clientOptions: { surface: 'codex' },
    };
    expect(storedClientSetup(plugin)).toBe(plugin);
    expect(storedClientSetup({ client: 'mst' })).toEqual({ client: 'api' });
    const none: { name: string; client?: string } = { name: 'none' };
    expect(storedClientSetup(none)).toBe(none);
  });
});

describe('runWithCurrentClients and summaryWithCurrentClients', () => {
  it('keep a stored plain chatgpt run on chatgpt', () => {
    const run = {
      variants: [
        { name: 'work', client: 'chatgpt' },
        {
          name: 'explicit',
          client: 'chatgpt',
          clientOptions: { surface: 'chatgpt-work' },
        },
      ],
      environment: {
        name: 'docker',
        machines: [{ shard: 1, client: 'chatgpt' }],
      },
    } as unknown as RunRecord;
    const current = runWithCurrentClients(run);
    expect(current.variants).toEqual([
      { name: 'work', client: 'chatgpt' },
      { name: 'explicit', client: 'chatgpt' },
    ]);
    expect(current.environment.machines?.[0]?.client).toBe('chatgpt');
    const summary = {
      variants: [
        {
          name: 'work',
          result: {
            caseResults: [
              { id: 'x', pass: true, request: { client: 'chatgpt' } },
            ],
          },
        },
      ],
      results: [
        {
          id: 'x',
          pass: true,
          variant: 'work',
          request: { client: 'chatgpt' },
        },
      ],
    } as unknown as EvaluationSummary;
    const read = summaryWithCurrentClients(summary, run);
    expect(read.results.map((r) => r.request?.client)).toEqual(['chatgpt']);
    expect(
      read.variants[0]!.result!.caseResults.map((r) => r.request?.client)
    ).toEqual(['chatgpt']);
  });

  it("map a chatgpt result by its variant's surface, and a machine only when every chatgpt variant was Codex", () => {
    const run = {
      variants: [
        { name: 'work', client: 'chatgpt' },
        {
          name: 'codex',
          client: 'chatgpt',
          clientOptions: { surface: 'codex' },
        },
        { name: 'api', client: 'api' },
      ],
      environment: {
        name: 'docker',
        machines: [{ shard: 1, client: 'chatgpt' }],
      },
    } as unknown as RunRecord;
    const result = (variant: string, client: string) => ({
      id: 'x',
      pass: true,
      variant,
      request: { client },
    });
    const summary = {
      variants: [
        { name: 'work', result: { caseResults: [result('work', 'chatgpt')] } },
        {
          name: 'codex',
          result: { caseResults: [result('codex', 'chatgpt')] },
        },
        // A case that named its own client keeps it.
        { name: 'api', result: { caseResults: [result('api', 'api')] } },
      ],
      results: [
        result('work', 'chatgpt'),
        result('codex', 'chatgpt'),
        result('codex', 'claude-code'),
      ],
    } as unknown as EvaluationSummary;
    const read = summaryWithCurrentClients(summary, run);
    expect(read.results.map((r) => r.request?.client)).toEqual([
      'chatgpt',
      'codex-app',
      'claude-code',
    ]);
    expect(
      read.variants.map((v) => v.result!.caseResults[0]!.request?.client)
    ).toEqual(['chatgpt', 'codex-app', 'api']);
    // Without run.json, a result reads by its name alone.
    expect(
      summaryWithCurrentClients(summary).results.map((r) => r.request?.client)
    ).toEqual(['chatgpt', 'chatgpt', 'claude-code']);
    // One of the two chatgpt variants was ChatGPT Work: a machine can't say.
    expect(runWithCurrentClients(run).environment.machines?.[0]?.client).toBe(
      'chatgpt'
    );
    const codexOnly = {
      ...run,
      variants: run.variants.slice(1),
    } as RunRecord;
    expect(
      runWithCurrentClients(codexOnly).environment.machines?.[0]?.client
    ).toBe('codex-app');
  });

  it("map a stored mst to api in variants, shards' machines and case results", () => {
    const run = {
      variants: [
        { name: 'a', client: 'mst' },
        { name: 'b', client: 'claude-code' },
        { name: 'c' },
      ],
      environment: {
        name: 'docker',
        machines: [
          { shard: 1, client: 'mst', ok: true, collected: 1 },
          { shard: 2, ok: true, collected: 1 },
        ],
      },
    } as unknown as RunRecord;
    const current = runWithCurrentClients(run);
    expect(current.variants.map((variant) => variant.client)).toEqual([
      'api',
      'claude-code',
      undefined,
    ]);
    expect(current.environment.machines?.map((m) => m.client)).toEqual([
      'api',
      undefined,
    ]);
    // The record it was given is unchanged.
    expect(run.variants[0]!.client).toBe('mst');

    const result = (id: string, client?: string) => ({
      id,
      pass: true,
      ...(client ? { request: { client } } : {}),
    });
    const summary = {
      variants: [
        {
          name: 'a',
          result: { caseResults: [result('x', 'mst'), result('y')] },
        },
        { name: 'b' },
      ],
      results: [result('x', 'mst'), result('z', 'acme/client/desk')],
    } as unknown as EvaluationSummary;
    const read = summaryWithCurrentClients(summary);
    expect(read.results.map((r) => r.request?.client)).toEqual([
      'api',
      'acme/client/desk',
    ]);
    expect(
      read.variants[0]!.result!.caseResults.map((r) => r.request?.client)
    ).toEqual(['api', undefined]);
    expect(read.variants[1]).toEqual({ name: 'b' });
  });
});
