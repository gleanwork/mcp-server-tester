import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { recordableOptions, runEval } from './runEval.js';
import { buildRunReport, runReportPath } from './runReport.js';
import { readRunDirectory } from './runFormat.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { MCPRunReportData } from '../types/reporter.js';
import { open } from '../cli/commands/open/index.js';

let dir: string;

const plugin: Plugin = {
  meta: { name: 'run-report', namespace: 'rr' },
  clients: {
    // Answers with its variant's name and calls one tool.
    echo: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => ({
        finalText: `${context.variant?.name ?? 'default'}: ${input.prompt}`,
        events: [
          {
            kind: 'tool_call',
            source: 'mcp',
            name: 'search',
            server: 'acme',
            arguments: { query: input.prompt },
            isError: false,
          },
        ],
      }),
    },
  },
  judges: {
    length: {
      schema: z.object({}),
      evaluate: async ({ trial }) => ({
        score: trial.text.length > 9 ? 1 : 0,
      }),
    },
  },
  pairwiseJudges: {
    longer: {
      schema: z.object({}),
      compare: async ({ baseline, candidate }) => ({
        preference:
          candidate.text.length > baseline.text.length
            ? ('candidate' as const)
            : ('baseline' as const),
        reasoning: 'the longer answer',
      }),
    },
  },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-report-'));
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        { id: 'one', input: 'hello', assertions: { containsText: 'hello' } },
        { id: 'two', input: 'bye', assertions: { containsText: 'longer' } },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'run-report',
      datasets: ['./cases.json'],
      client: 'rr/client/echo',
      model: 'model-a',
      servers: {},
      trials: 2,
      // The report shows what the run stored: answers too, here.
      redactStoredResponses: false,
      judges: ['rr/judge/length'],
      pairwiseJudges: ['rr/pairwise-judge/longer'],
      variants: [
        { name: 'base' },
        {
          name: 'longer',
          model: 'model-b',
          description: 'A longer name, so a longer answer',
        },
      ],
    })
  );
});
afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const run = () =>
  runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
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

describe('the run report', () => {
  it('is written with every run, from the run’s files', async () => {
    const result = await run();
    const report = await readReport(result.outputDir);
    for (const file of ['index.html', 'app.js', 'styles.css'])
      await expect(
        fs.stat(path.join(result.outputDir, 'report', file))
      ).resolves.toBeTruthy();
    expect(report).toEqual(
      buildRunReport(await readRunDirectory(result.outputDir))
    );

    expect(report.run).toMatchObject({
      evalName: 'run-report',
      baseline: 'base',
      baselineRan: true,
      cases: 2,
      trialsPerCase: { min: 2, max: 2 },
      partial: false,
      redacted: false,
    });
    expect(report.comparison).toMatchObject({
      purpose: 'eval',
      baselineId: 'base',
      baselineName: 'base',
    });
    const [base, longer] = report.variants;
    expect(base).toMatchObject({
      name: 'base',
      baseline: true,
      verdict: 'baseline',
    });
    expect(longer).toMatchObject({
      name: 'longer',
      baseline: false,
      model: 'model-b',
      description: 'A longer name, so a longer answer',
      toolsUsed: [{ name: 'search', share: 1 }],
    });
    expect(longer!.judgeScores).toEqual([
      { judge: 'rr/judge/length', mean: 1 },
    ]);
    expect(longer!.pairwise).toEqual([
      expect.objectContaining({
        judge: 'rr/pairwise-judge/longer',
        compared: 2,
        wins: 2,
        losses: 0,
      }),
    ]);
  });

  it('shows what differs from the baseline, and every trial in full', async () => {
    const result = await run();
    const report = await readReport(result.outputDir);
    expect(report.differences.longer).toEqual([
      { field: 'model', baseline: 'model-a', variant: 'model-b' },
    ]);
    // Tool metadata a variant shows its client is diffed from run.json.
    const stored = await readRunDirectory(result.outputDir);
    stored.run.variants[1]!.tools = {
      search: { description: 'Search everything.' },
    };
    const entry = buildRunReport(stored).comparison.variants.find(
      (v) => v.id === 'longer'
    );
    expect(entry?.toolChanges).toEqual([
      { tool: 'search', field: 'description', after: 'Search everything.' },
    ]);
    const trials = report.trials.longer!.two!;
    expect(trials).toHaveLength(2);
    expect(trials[0]).toMatchObject({
      pass: true,
      finalText: 'longer: bye',
      events: [
        {
          kind: 'tool_call',
          name: 'search',
          server: 'acme',
          input: '{"query":"bye"}',
        },
      ],
    });
    expect(trials[0]!.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grader: 'textContains', pass: true }),
        expect.objectContaining({
          grader: 'rr/judge/length',
          judge: true,
          score: 1,
        }),
      ])
    );
    expect(report.preferences.longer!.one).toEqual([
      {
        judge: 'rr/pairwise-judge/longer',
        preference: 'candidate',
        reasoning: 'the longer answer',
      },
    ]);
    expect(trials[0]!.traced).toBe(true);
  });

  it('says what graded the trials, and which graders read the answer', async () => {
    const report = await readReport((await run()).outputDir);
    expect(report.graders).toEqual([
      { name: 'textContains', judge: false, readsAnswer: true },
      { name: 'rr/judge/length', judge: true, readsAnswer: true },
    ]);
    // A trace-only grader never reads the answer.
    const stored = await readRunDirectory((await run()).outputDir);
    for (const result of stored.summary.results)
      for (const trial of result.trialResults ?? [result])
        (trial as { scores?: Record<string, unknown> }).scores = {
          toolsTriggered: { pass: true },
        };
    expect(buildRunReport(stored).graders).toEqual([
      { name: 'toolsTriggered', judge: false, readsAnswer: false },
    ]);
  });
});

describe('a redacted run', () => {
  it('says so, and its trials have no answers', async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(dir, 'eval.json'), 'utf8')
    ) as Record<string, unknown>;
    delete config.redactStoredResponses;
    await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify(config));
    const result = await run();
    const report = await readReport(result.outputDir);
    expect(report.run.redacted).toBe(true);
    expect(report.trials.longer!.one![0]!.finalText).toBeUndefined();
    // Judges' and pairwise judges' words can quote the answer.
    const judged = report.trials.longer!.one![0]!.scores.find((s) => s.judge);
    expect(judged).toMatchObject({ grader: 'rr/judge/length', score: 1 });
    expect(judged?.details).toBeUndefined();
    expect(report.preferences.longer!.one![0]!.reasoning).toBeUndefined();
  });
});

describe('a run without its baseline', () => {
  it('compares with the first variant that ran, and says so', async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(dir, 'eval.json'), 'utf8')
    ) as { variants: unknown[] };
    config.variants.push({ name: 'third', model: 'model-c' });
    await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify(config));
    const result = await runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
      plugins: [plugin],
      variant: ['longer', 'third'],
    });
    const report = await readReport(result.outputDir);
    expect(report.run).toMatchObject({
      baseline: 'base',
      baselineRan: false,
      partial: true,
    });
    expect(report.comparison.baselineName).toBe('longer');
    expect(report.variants.map((v) => [v.name, v.baseline])).toEqual([
      ['longer', true],
      ['third', false],
    ]);
  });
});

describe('client options in run.json', () => {
  it('keep plain values, and hash any that might be a credential', () => {
    const key = Buffer.alloc(32, 1);
    const recorded = recordableOptions(
      {
        appVersion: '1.2.3',
        effort: 'high',
        retries: 2,
        headless: true,
        apiKey: 'abc',
        baseUrl: 'https://example.com/?api_key=secret',
        endpoint: 'https://example.com',
        label: 'k=v',
        opaque: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
        nested: { token: 'x' },
      },
      key
    );
    expect(recorded).toMatchObject({
      appVersion: '1.2.3',
      effort: 'high',
      retries: 2,
      headless: true,
    });
    for (const name of [
      'apiKey',
      'baseUrl',
      'endpoint',
      'label',
      'opaque',
      'nested',
    ])
      expect(recorded[name]).toMatch(/^hmac:[0-9a-f]{16}$/);
    // Keyed per run: the same value hashes differently in another run.
    expect(
      recordableOptions({ apiKey: 'abc' }, Buffer.alloc(32, 2)).apiKey
    ).not.toBe(recorded.apiKey);
  });
});

describe('mst open', () => {
  it('finds the newest run, an eval’s latest run, or the run named, and writes a missing report', async () => {
    const first = await run();
    const second = await run();
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.push(line);
    });
    const root = path.join(dir, '.mcp-test-results');

    await open(undefined, { dir: root, print: true });
    expect(printed.pop()).toBe(runReportPath(second.outputDir));

    await open(path.join(root, 'run-report'), { print: true });
    expect(printed.pop()).toBe(runReportPath(second.outputDir));

    await fs.rm(path.join(first.outputDir, 'report'), { recursive: true });
    await open(first.outputDir, { print: true });
    expect(printed.pop()).toBe(runReportPath(first.outputDir));
    await expect(fs.stat(runReportPath(first.outputDir))).resolves.toBeTruthy();
  });

  it('says what a path is when it isn’t a run', async () => {
    await expect(open(dir, { print: true })).rejects.toThrow(
      /neither a run directory \(with run\.json\) nor an eval's results directory/
    );
  });
});
