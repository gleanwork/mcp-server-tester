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
import { printJudgeModels, printRunResult } from '../cli/commands/run/index.js';

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
        // What the client ran, as Cowork records it.
        telemetry: {
          clientApp: {
            name: 'Claude',
            version: '2.31226.1',
            source: 'installed',
          },
        },
        // Most of an agent's input comes from the prompt cache.
        usage: {
          inputTokens: 10,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 20,
          outputTokens: 5,
          durationMs: 1,
        },
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
    // Can't tell on case two.
    unsure: {
      schema: z.object({}),
      evaluate: async ({ case: judged }) =>
        judged.id === 'two'
          ? { score: 0, unknown: true, reasoning: 'cannot tell' }
          : { score: 1 },
    },
    // Answers by its model: `strict` fails case two, the others pass all.
    // `lenient: true` passes everything.
    voter: {
      version: '1',
      schema: z.object({
        model: z.string(),
        lenient: z.boolean().optional(),
      }),
      evaluate: async ({ case: judged }, options) => {
        const { model, lenient } = options as {
          model: string;
          lenient?: boolean;
        };
        return {
          score: model === 'strict' && !lenient && judged.id === 'two' ? 0 : 1,
          model,
        };
      },
    },
    // Two criteria: `greets` passes everywhere; `short` fails on case two.
    checks: {
      schema: z.object({ model: z.string().optional() }),
      evaluate: async ({ case: judged }) => ({
        score: judged.id === 'two' ? 0 : 1,
        criteria: [
          { id: 'greets', text: 'Greets the user.', verdict: 'pass' },
          {
            id: 'short',
            text: 'Is short.',
            verdict: judged.id === 'two' ? 'fail' : 'pass',
          },
        ],
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

  it('gives every pass rate a 95% range, and says when there are too few trials to tell', async () => {
    // Two cases say almost nothing, however many trials each ran: base
    // passes one and fails the other, with 1 degree of freedom.
    const pair = await readReport((await run()).outputDir);
    const [base, longer] = pair.comparison.variants;
    expect(base!.capability.interval!.tooWide).toBe(true);
    expect(base!.capability.interval!.lower).toBeLessThan(0.01);
    expect(base!.capability.interval!.upper).toBeGreaterThan(0.99);
    // longer passes every trial, and is still far from pinned down.
    expect(longer!.capability.interval!.tooWide).toBe(true);
    // A case's own range is over its trials: 2 of 2.
    expect(pair.comparison.cases[0]!.intervals!.base!.lower).toBeCloseTo(
      0.1581,
      4
    );
    // More trials can't fix cases that differ this much.
    expect(pair.evidence).toMatchObject({ tooWide: true, allPassed: false });
    expect(pair.evidence!.suggestedTrialsPerCase).toBeUndefined();

    // Eight cases, one trial each, all passing: 8 of 8.
    await fs.writeFile(
      path.join(dir, 'eight.json'),
      JSON.stringify({
        name: 'eight',
        cases: Array.from({ length: 8 }, (_, i) => ({
          id: `case-${i}`,
          input: `hello ${i}`,
          assertions: { containsText: 'hello' },
        })),
      })
    );
    await fs.writeFile(
      path.join(dir, 'eight-eval.json'),
      JSON.stringify({
        name: 'eight',
        datasets: ['./eight.json'],
        client: 'rr/client/echo',
        model: 'model-a',
        servers: {},
      })
    );
    const eight = await runEval({
      configPath: path.join(dir, 'eight-eval.json'),
      rootDir: dir,
      plugins: [plugin],
    });
    const report = await readReport(eight.outputDir);
    const interval = report.comparison.variants[0]!.capability.interval!;
    expect(interval.effectiveTrials).toBe(8);
    expect(interval.lower).toBeCloseTo(0.6306, 4);
    expect(report.evidence).toEqual({
      tooWide: true,
      allPassed: true,
      trialsPerCase: 1,
      // 80 passing trials would be expected to pin it down.
      suggestedTrialsPerCase: 10,
      suggestedTrials: 80,
      ...(report.evidence!.estimatedMinutes !== undefined
        ? { estimatedMinutes: report.evidence!.estimatedMinutes }
        : {}),
      trialsToShow: [
        { rate: 0.9, trials: 36 },
        { rate: 0.95, trials: 72 },
      ],
    });

    // The suggestion's time and cost come from this run's pace: 8 trials in
    // 2 minutes, at $0.01 a trial.
    const stored = await readRunDirectory(eight.outputDir);
    stored.run.createdAt = '2026-01-01T00:00:00.000Z';
    stored.run.finishedAt = '2026-01-01T00:02:00.000Z';
    for (const variant of stored.summary.variants)
      variant.metrics = { ...variant.metrics, cost_usd_mean: 0.01 };
    const evidence = buildRunReport(stored).evidence!;
    expect(evidence.estimatedMinutes).toBeCloseTo(20, 6);
    expect(evidence.estimatedCostUsd).toBeCloseTo(0.8, 6);
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
    // Everything the model read, cached or not, and wrote.
    expect(trials[0]!.tokens).toBe(135);
    // Provenance: the client app the trials ran, and the dataset's hash.
    expect(report.run.clientApps).toEqual(['Claude 2.31226.1']);
    expect(report.run.datasets[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.run.environment).toEqual({ name: 'local', shards: 1 });
  });

  it("shows a judge's unknown answers, and leaves them out of its pass rate", async () => {
    const configPath = path.join(dir, 'eval.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, judges: ['rr/judge/unsure'] })
    );
    const result = await run();
    const report = await readReport(result.outputDir);
    const [trial] = report.trials.base!.two!;
    expect(trial!.pass).toBe(false);
    expect(trial!.scores).toContainEqual(
      expect.objectContaining({
        grader: 'rr/judge/unsure',
        judge: true,
        pass: false,
        unknown: true,
        reasoning: 'cannot tell',
      })
    );
    const judges = report.variants.find(
      (v) => v.name === 'base'
    )!.judgeCalibration;
    // Two trials of case one passed; case two's two trials are unknown.
    expect(judges).toEqual([
      expect.objectContaining({
        judge: 'rr/judge/unsure',
        judged: 2,
        passed: 2,
        unknown: 2,
        passRate: 1,
      }),
    ]);
  });

  it("shows a jury's members, their agreement, and a judge from the client's family", async () => {
    const configPath = path.join(dir, 'eval.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...config,
        model: 'claude-client',
        judges: [
          {
            type: 'rr/judge/voter',
            jury: [
              { model: 'strict' },
              { model: 'lenient' },
              { model: 'claude-x' },
            ],
          },
        ],
      })
    );
    const result = await run();
    const report = await readReport(result.outputDir);
    const variant = report.variants.find((v) => v.name === 'base')!;
    const [judge] = variant.judgeCalibration!;
    // Two of three members pass every trial, so the jury does.
    expect(judge).toMatchObject({
      judge: 'rr/judge/voter',
      judged: 4,
      passed: 4,
      models: ['strict', 'lenient', 'claude-x'],
      jury: {
        members: [
          { member: 'strict', passed: 2, failed: 2 },
          { member: 'lenient', passed: 4, failed: 0 },
          { member: 'claude-x', passed: 4, failed: 0 },
        ],
      },
    });
    expect(judge!.jury!.alpha).toBeLessThan(1);
    const [trial] = report.trials.base!.two!;
    expect(trial!.scores).toContainEqual(
      expect.objectContaining({
        grader: 'rr/judge/voter',
        jury: [
          expect.objectContaining({ model: 'strict', verdict: 'fail' }),
          expect.objectContaining({ model: 'lenient', verdict: 'pass' }),
          expect.objectContaining({ model: 'claude-x', verdict: 'pass' }),
        ],
      })
    );
    // The client is a Claude model, and so is one member.
    expect(judge!.sameFamilyAsClient).toEqual(['claude-x']);
    // The `longer` variant's client isn't, so its row has no warning.
    expect(
      report.variants.find((v) => v.name === 'longer')!.judgeCalibration![0]
    ).not.toHaveProperty('sameFamilyAsClient');
    // The run output names the models and warns once per pair.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    printJudgeModels(result.summary.results);
    expect(log).toHaveBeenCalledWith(
      'Judges: rr/judge/voter (strict, lenient, claude-x)'
    );
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining(
        'judge "rr/judge/voter" ran on claude-x, from the same family as the client\'s claude-client'
      ),
    ]);
  });

  it('keeps jury members on one model apart, and checks each case against its own client model', async () => {
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          { id: 'one', input: 'hello' },
          // This case's client is a Claude model; the variant's isn't.
          { id: 'two', input: 'bye', model: 'claude-case' },
        ],
      })
    );
    const configPath = path.join(dir, 'eval.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...config,
        variants: [{ name: 'base' }],
        pairwiseJudges: undefined,
        judges: [
          {
            type: 'rr/judge/voter',
            model: 'strict',
            jury: [{}, { lenient: true }, { model: 'claude-x' }],
          },
        ],
      })
    );
    const report = await readReport((await run()).outputDir);
    const [judge] = report.variants[0]!.judgeCalibration!;
    const members = judge!.jury!.members;
    // Two members run `strict`: both rows stay, told apart by identity.
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.member)).toEqual([
      expect.stringMatching(/^strict \([0-9a-f]{8}\)$/),
      expect.stringMatching(/^strict \([0-9a-f]{8}\)$/),
      'claude-x',
    ]);
    expect(members[0]!.member).not.toBe(members[1]!.member);
    expect(members.map(({ passed, failed }) => [passed, failed])).toEqual([
      [2, 2],
      [4, 0],
      [4, 0],
    ]);
    // The two strict members disagree on case two's trials: alpha below 1.
    expect(judge!.jury!.alpha).toBeLessThan(1);
    // Case two's own client model is Claude, so claude-x is flagged.
    expect(judge!.sameFamilyAsClient).toEqual(['claude-x']);
  });

  it("checks a criteria jury's models one by one against the client's family", async () => {
    const configPath = path.join(dir, 'eval.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...config,
        model: 'gpt-5',
        judges: [
          {
            type: 'rr/judge/checks',
            jury: [{ model: 'gpt-5-mini' }, { model: 'claude-sonnet-4-6' }],
          },
        ],
      })
    );
    const report = await readReport((await run()).outputDir);
    const rows = report.variants.find(
      (v) => v.name === 'base'
    )!.judgeCalibration!;
    expect(rows.map((row) => row.judge)).toEqual([
      'rr/judge/checks#greets',
      'rr/judge/checks#short',
    ]);
    for (const row of rows) {
      expect(row.models).toEqual(['gpt-5-mini', 'claude-sonnet-4-6']);
      expect(row.sameFamilyAsClient).toEqual(['gpt-5-mini']);
      // Members' counts and alpha are for a whole verdict, not a criterion.
      expect(row).not.toHaveProperty('jury');
    }
  });

  it("shows a pass rate for each of a judge's criteria", async () => {
    const configPath = path.join(dir, 'eval.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, judges: ['rr/judge/checks'] })
    );
    const report = await readReport((await run()).outputDir);
    const judges = report.variants.find(
      (v) => v.name === 'base'
    )!.judgeCalibration;
    // Each criterion is its own row; the judge's whole verdict isn't one.
    expect(judges).toEqual([
      expect.objectContaining({
        judge: 'rr/judge/checks#greets',
        judged: 4,
        passed: 4,
        passRate: 1,
        status: 'uncalibrated',
      }),
      expect.objectContaining({
        judge: 'rr/judge/checks#short',
        judged: 4,
        passed: 2,
        passRate: 0.5,
        status: 'uncalibrated',
      }),
    ]);
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

  it('has no trace for a client that cannot see tool calls', async () => {
    const stored = await readRunDirectory((await run()).outputDir);
    const result = stored.summary.results.find((r) => r.variant === 'longer')!;
    const trial = (result.trialResults ?? [result])[0] as {
      trace?: { evidence?: string; events?: unknown[] };
    };
    trial.trace = { ...trial.trace, evidence: 'none', events: [] };
    const report = buildRunReport(stored);
    expect(report.trials.longer![result.id]![0]!.traced).toBe(false);
  });
});

describe("mst run's output", () => {
  it('prints the report’s pass rates with their ranges, and the same flag', async () => {
    const first = await run();
    const second = await run();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      printRunResult(second, 'eval.json');
      const lines = log.mock.calls.map((call) => String(call[0]));
      const header = lines.find((line) => line.startsWith('Variant'));
      expect(header).toMatch(/Passed\s+Pass rate\s+Likely range/);
      // Two cases can't pin down anything, even when every trial passes.
      expect(lines.find((line) => line.startsWith('base '))).toMatch(
        /1\/2\s+50%\s+0%-100% !/
      );
      expect(lines.find((line) => line.startsWith('longer '))).toMatch(
        /2\/2\s+100%\s+0%-100% !/
      );
      expect(lines).toContain(
        "! Too few trials to tell: with 2 trials per case, base's true pass rate is likely anywhere from 0% to 100%. More trials per case won't narrow it enough with 2 cases: add cases."
      );
      // The previous run, through the same paired test.
      expect(lines).toContain(
        `Previous run ${first.summary.runId} (${first.summary.timestamp}):`
      );
      expect(lines).toContain(
        '  base: no change: every case passed as many trials as before'
      );
    } finally {
      log.mockRestore();
      process.exitCode = exitCode;
    }
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
