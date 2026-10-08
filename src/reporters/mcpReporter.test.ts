/**
 * The MCP reporter writes each Playwright run's eval results as a run in the
 * mst.run/v1 format, with a variant per project and the run's report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import MCPReporter from './mcpReporter.js';
import { attachReporterData, type ReporterAttachment } from './channel.js';
import type {
  EvalCaseResult,
  MCPRunReportData,
  MCPToolOptimizationData,
} from '../types/reporter.js';
import type { EvaluationSummary } from '../evals/evalFrameworkTypes.js';
import { readRunDirectory } from '../evals/runFormat.js';
import { runReportPath } from '../evals/runReport.js';
import type {
  EvalResultStore,
  StoredArtifactKind,
  StoredEvalArtifact,
} from '../evals/resultStore.js';

vi.mock('open', () => ({ default: vi.fn() }));

let outputDir: string;
beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-reporter-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(outputDir, { recursive: true, force: true });
});

function result(
  id: string,
  pass: boolean,
  extra: Partial<EvalCaseResult> = {}
): EvalCaseResult {
  return {
    id,
    datasetName: 'weather',
    source: 'eval',
    pass,
    scores: { textContains: { pass } },
    response: { content: [{ type: 'text', text: 'PRIVATE_RESPONSE' }] },
    durationMs: 10,
    ...extra,
  };
}

const projects = [
  {
    name: 'stdio',
    use: {
      mcpConfig: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--token=SECRET_ARG'],
        env: { API_KEY: 'SECRET_ENV' },
      },
    },
  },
  {
    name: 'http',
    use: {
      mcpConfig: {
        transport: 'http',
        serverUrl: 'https://user:pass@example.com/mcp?key=SECRET_QUERY',
        headers: { Authorization: 'Bearer SECRET_HEADER' },
      },
    },
  },
];

async function attachmentsOf(
  ...items: ReporterAttachment[]
): Promise<TestResult['attachments']> {
  const attachments: TestResult['attachments'] = [];
  for (const item of items)
    await attachReporterData(
      {
        attach: async (
          name: string,
          options: { contentType: string; body: string | Buffer }
        ) => {
          attachments.push({
            name,
            contentType: options.contentType,
            body:
              typeof options.body === 'string'
                ? Buffer.from(options.body)
                : options.body,
          });
        },
      },
      item
    );
  return attachments;
}

/** Run the reporter over (project, attachments) pairs; a repeated `id` is a retry. */
async function run(
  tests: Array<{
    project: string;
    id?: string;
    title?: string;
    attachments: TestResult['attachments'];
  }>,
  options: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
): Promise<string | undefined> {
  const reporter = new MCPReporter({ quiet: true, outputDir, ...options });
  reporter.onBegin(
    { projects, ...config } as unknown as FullConfig,
    {} as Suite
  );
  for (const [index, test] of tests.entries())
    await reporter.onTestEnd(
      {
        id: test.id ?? `${test.project}-${index}`,
        title: test.title ?? 'eval',
        parent: { title: 'suite', project: () => ({ name: test.project }) },
      } as unknown as TestCase,
      { status: 'passed', attachments: test.attachments } as TestResult
    );
  await reporter.onEnd({} as FullResult);
  try {
    const latest = JSON.parse(
      await fs.readFile(
        path.join(
          outputDir,
          (options.name as string) ?? 'playwright',
          'latest.json'
        ),
        'utf8'
      )
    ) as { path: string };
    return path.join(
      outputDir,
      (options.name as string) ?? 'playwright',
      latest.path
    );
  } catch {
    return undefined;
  }
}

const evalResults = (caseResults: EvalCaseResult[]): ReporterAttachment => ({
  kind: 'evalResults',
  data: { caseResults },
});

async function readReport(runDirectory: string): Promise<MCPRunReportData> {
  const script = await fs.readFile(
    path.join(runDirectory, 'report', 'data.js'),
    'utf8'
  );
  return JSON.parse(
    script.replace(/^window\.MST_RUN_REPORT = /, '').replace(/;\s*$/, '')
  ) as MCPRunReportData;
}

describe('MCPReporter', () => {
  it('writes a run with a variant per project, and its report', async () => {
    const directory = await run(
      [
        {
          project: 'stdio',
          attachments: await attachmentsOf(
            evalResults([result('sunny', true), result('rainy', false)])
          ),
        },
        {
          project: 'http',
          attachments: await attachmentsOf(
            evalResults([result('sunny', true), result('rainy', true)])
          ),
        },
      ],
      { name: 'weather-server' }
    );
    expect(directory).toBeDefined();
    const stored = await readRunDirectory(directory!);
    expect(stored.run).toMatchObject({
      evalName: 'weather-server',
      baseline: 'stdio',
      partial: false,
      redactStoredResponses: true,
      datasets: [{ name: 'weather', caseCount: 2 }],
    });
    expect(stored.summary.variants.map((v) => v.name)).toEqual([
      'stdio',
      'http',
    ]);
    expect(stored.summary.variants[1]!.result).toMatchObject({
      total: 2,
      passed: 2,
    });
    expect(stored.summary.variants[0]!.metrics?.passed_rate).toBe(0.5);
    await expect(fs.stat(runReportPath(directory!))).resolves.toBeTruthy();
    const report = await readReport(directory!);
    expect(report.variants.map((v) => [v.name, v.baseline])).toEqual([
      ['stdio', true],
      ['http', false],
    ]);
  });

  it('records each project’s server without anything that can hold a credential', async () => {
    const directory = await run([
      {
        project: 'stdio',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
      {
        project: 'http',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
    ]);
    const runJson = await fs.readFile(
      path.join(directory!, 'run.json'),
      'utf8'
    );
    for (const secret of [
      'SECRET_ARG',
      'SECRET_ENV',
      'SECRET_QUERY',
      'SECRET_HEADER',
      'user:pass',
    ])
      expect(runJson).not.toContain(secret);
    const stored = await readRunDirectory(directory!);
    expect(stored.run.variants).toEqual([
      expect.objectContaining({
        name: 'stdio',
        servers: [{ transport: 'stdio', command: 'node' }],
      }),
      expect.objectContaining({
        name: 'http',
        servers: [{ transport: 'http', serverUrl: 'https://example.com/mcp' }],
      }),
    ]);
  });

  it('redacts responses unless told not to', async () => {
    const attachments = await attachmentsOf(evalResults([result('a', true)]));
    const redacted = await run([{ project: 'stdio', attachments }]);
    const text = async (dir: string) =>
      (await fs.readFile(path.join(dir, 'results.json'), 'utf8')) +
      (await fs.readFile(path.join(dir, 'report', 'data.js'), 'utf8'));
    expect(await text(redacted!)).not.toContain('PRIVATE_RESPONSE');
    const kept = await run([{ project: 'stdio', attachments }], {
      redactStoredResponses: false,
    });
    expect(await text(kept!)).toContain('PRIVATE_RESPONSE');
  });

  it('compares a run with the previous one', async () => {
    const first = await run([
      {
        project: 'stdio',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
    ]);
    const second = await run([
      {
        project: 'stdio',
        attachments: await attachmentsOf(evalResults([result('a', false)])),
      },
    ]);
    const stored = await readRunDirectory(second!);
    expect(stored.summary.previousRun).toMatchObject({
      runId: path.basename(first!),
      passRateDelta: -1,
      variants: { stdio: { regressed: ['a'] } },
    });
  });

  it('saves the run summary to a result store', async () => {
    const saved: Array<StoredEvalArtifact<unknown>> = [];
    const store: EvalResultStore = {
      saveArtifact: async (artifact) => {
        saved.push(artifact as StoredEvalArtifact<unknown>);
      },
      loadArtifact: async () => {
        throw new Error('none');
      },
      loadLatestArtifact: async () => null,
      listArtifacts: async (_kind: StoredArtifactKind) => [],
    };
    const directory = await run(
      [
        {
          project: 'stdio',
          attachments: await attachmentsOf(evalResults([result('a', true)])),
        },
      ],
      { resultStore: store, runMetadata: { branch: 'main' } }
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'eval-run-summary',
      id: path.basename(directory!),
      metadata: {
        branch: 'main',
        labels: { configId: 'playwright:playwright' },
      },
    });
    expect(JSON.stringify(saved[0]!.data)).not.toContain('PRIVATE_RESPONSE');
    expect((saved[0]!.data as EvaluationSummary).variants).toHaveLength(1);
  });

  it('writes a tool optimization’s report', async () => {
    const optimization = {
      metric: 'passRate',
      baselineValue: 0.5,
      bestValue: 0.75,
      rounds: [],
      reason: 'threshold-met',
    } as unknown as MCPToolOptimizationData;
    const directory = await run([
      {
        project: 'stdio',
        attachments: await attachmentsOf({
          kind: 'toolOptimization',
          data: optimization,
        }),
      },
    ]);
    const report = await readReport(directory!);
    expect(report.toolOptimization).toEqual(optimization);
    expect(report.variants).toEqual([]);
  });

  it('writes nothing for a run without evals', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await run(
        [
          {
            project: 'stdio',
            attachments: await attachmentsOf({
              kind: 'toolCall',
              data: {
                operation: 'callTool',
                toolName: 'get_weather',
                args: {},
                result: { content: [] },
                durationMs: 1,
                isError: false,
              },
            }),
          },
        ],
        { quiet: false }
      )
    ).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Playwright's own report")
    );
  });

  it('puts projects in config order, so the baseline is the same every run', async () => {
    const directory = await run([
      {
        project: 'http',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
      {
        project: 'stdio',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
    ]);
    const stored = await readRunDirectory(directory!);
    expect(stored.run.baseline).toBe('stdio');
    expect(stored.summary.variants.map((v) => v.name)).toEqual([
      'stdio',
      'http',
    ]);
    expect(stored.summary.variantDeltas.http).toMatchObject({
      baseline: 'stdio',
      passRateDelta: 0,
    });
  });

  it('counts a retried test once: its last attempt', async () => {
    const directory = await run([
      {
        project: 'stdio',
        id: 'flaky',
        attachments: await attachmentsOf(evalResults([result('a', false)])),
      },
      {
        project: 'stdio',
        id: 'flaky',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      },
    ]);
    const stored = await readRunDirectory(directory!);
    expect(stored.summary.results).toEqual([
      expect.objectContaining({ id: 'a', pass: true }),
    ]);
  });

  it('calls the unnamed default project `default`, with its server', async () => {
    const reporter = new MCPReporter({ quiet: true, outputDir });
    reporter.onBegin(
      {
        projects: [
          { name: '', use: { mcpConfig: projects[0]!.use.mcpConfig } },
        ],
      } as unknown as FullConfig,
      {} as Suite
    );
    await reporter.onTestEnd(
      {
        id: 't',
        title: 'eval',
        parent: { title: 'suite', project: () => ({ name: '' }) },
      } as unknown as TestCase,
      {
        status: 'passed',
        attachments: await attachmentsOf(evalResults([result('a', true)])),
      } as TestResult
    );
    await reporter.onEnd({} as FullResult);
    const latest = JSON.parse(
      await fs.readFile(
        path.join(outputDir, 'playwright', 'latest.json'),
        'utf8'
      )
    ) as { path: string };
    const stored = await readRunDirectory(
      path.join(outputDir, 'playwright', latest.path)
    );
    expect(stored.run.variants).toEqual([
      expect.objectContaining({
        name: 'default',
        servers: [{ transport: 'stdio', command: 'node' }],
      }),
    ]);
  });

  it('names a case two tests ran after each test, the same in every project', async () => {
    const tests = [];
    for (const project of ['stdio', 'http'])
      for (const [title, pass] of [
        ['serially', true],
        ['in parallel', false],
      ] as const)
        tests.push({
          project,
          title,
          attachments: await attachmentsOf(evalResults([result('a', pass)])),
        });
    const stored = await readRunDirectory((await run(tests))!);
    expect(
      stored.summary.results.map((r) => [r.variant, r.id, r.pass])
    ).toEqual([
      ['stdio', 'a (serially)', true],
      ['stdio', 'a (in parallel)', false],
      ['http', 'a (serially)', true],
      ['http', 'a (in parallel)', false],
    ]);
  });

  it('names one ID in two datasets of a test after its dataset', async () => {
    const stored = await readRunDirectory(
      (await run([
        {
          project: 'stdio',
          attachments: await attachmentsOf(
            evalResults([
              result('a', true, { datasetName: 'one' }),
              result('A', false, { datasetName: 'two' }),
            ])
          ),
        },
      ]))!
    );
    expect(stored.summary.results.map((r) => r.id)).toEqual(['one/a', 'two/A']);
  });

  it('refuses one dataset with the same case twice, and says why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await run([
      {
        project: 'stdio',
        attachments: await attachmentsOf(
          evalResults([result('a', true), result('A', true)])
        ),
      },
    ]);
    expect(directory).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("wasn't written"),
      expect.objectContaining({
        message: expect.stringContaining('twice in one dataset'),
      })
    );
    error.mockRestore();
  });

  it('writes a shard as a partial run that never becomes the latest', async () => {
    const attachments = await attachmentsOf(evalResults([result('a', true)]));
    const reporter = new MCPReporter({ quiet: true, outputDir });
    reporter.onBegin(
      { projects, shard: { current: 2, total: 3 } } as unknown as FullConfig,
      {} as Suite
    );
    await reporter.onTestEnd(
      {
        id: 't',
        title: 'eval',
        parent: { title: 'suite', project: () => ({ name: 'stdio' }) },
      } as unknown as TestCase,
      { status: 'passed', attachments } as TestResult
    );
    await reporter.onEnd({} as FullResult);
    const evalDir = path.join(outputDir, 'playwright');
    await expect(fs.stat(path.join(evalDir, 'latest.json'))).rejects.toThrow();
    const [runId] = await fs.readdir(path.join(evalDir, 'runs'));
    const stored = await readRunDirectory(path.join(evalDir, 'runs', runId!));
    expect(stored.run).toMatchObject({
      partial: true,
      selection: { shard: '2/3' },
    });
  });

  it.each([
    ['historyLimit', 5],
    ['includeAutoTracking', false],
    ['runId', 'x'],
  ])('rejects the removed `%s` option with what to do', (key, value) => {
    expect(() => new MCPReporter({ [key]: value } as never)).toThrow(
      new RegExp(`\`${key}\` was removed`)
    );
  });
});
