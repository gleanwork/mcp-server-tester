import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import { RUN_FORMAT } from './resultFormat.js';
import { writeRun, type RunFacts, type RunRecord } from './runFormat.js';
import { fileRunStore, uploadRun, type RunStore } from './runStore.js';
import {
  HISTORY_FORMAT,
  buildHistory,
  deriveHistory,
  isHistoryPoint,
  localHistoryLocation,
  readHistory,
  storeHistoryLocation,
  updateHistory,
} from './runHistory.js';
import type { HistoryIndex } from '../types/history.js';
import { formatHistory, history } from '../cli/commands/history/index.js';
import { metricsOf } from '../reporters/ui-src/components/History/historyData.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-history-'));
  dirs.push(dir);
  return dir;
}

/** A variant's cases: `[passed trials, trials]` by case ID. */
type Outcomes = Record<string, [number, number]>;

interface RunSpec {
  id: string;
  /** When it ran: the run's summary timestamp. */
  at: string;
  variants: Record<string, Outcomes>;
  judge?: string;
  /** Per-variant cost of a trial. */
  cost?: Record<string, number>;
  partial?: boolean;
  gradedFrom?: string;
  collectedAt?: string;
  model?: Record<string, string>;
  datasetHash?: string;
  infra?: Record<string, string[]>;
  grade?: 'complete' | 'skipped';
  simulateWrites?: boolean;
  /** Per-variant fields of its run.json record, over the defaults. */
  setup?: Record<string, Partial<RunRecord['variants'][number]>>;
  plugins?: RunFacts['plugins'];
  /** The identity each judge score records (a case judge's, say). */
  scoreIdentity?: string;
}

function caseResult(
  variant: string,
  id: string,
  [passed, trials]: [number, number],
  options: {
    cost?: number;
    infra?: boolean;
    judge?: boolean;
    identity?: string;
  }
): EvalCaseResult {
  const trialResults = Array.from({ length: trials }, (_, index) => ({
    pass: index < passed,
    durationMs: 1000 * (index + 1),
    clientUsage: {
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 1000,
      ...(options.cost !== undefined ? { totalCostUsd: options.cost } : {}),
    },
    scores: options.judge
      ? {
          judge: {
            pass: index < passed,
            score: index < passed ? 1 : 0,
            judgeName: 'rubric',
            ...(options.identity ? { judgeIdentity: options.identity } : {}),
          },
        }
      : {},
  }));
  if (options.infra)
    trialResults.push({
      pass: false,
      durationMs: 0,
      ending: {
        kind: 'infrastructure',
        broke: 'network',
        retryable: true,
        reason: 'offline',
      },
      isInfrastructureError: true,
    } as never);
  return {
    id,
    datasetName: 'cases',
    source: 'eval',
    variant,
    pass: passed === trials,
    scores: {},
    durationMs: 1000,
    trialResults,
  } as unknown as EvalCaseResult;
}

/** Writes a run through the run format's own writer. */
async function writeSpec(evalDirectory: string, spec: RunSpec): Promise<void> {
  const variants = Object.entries(spec.variants).map(([name, outcomes]) => {
    const caseResults = Object.entries(outcomes).map(([id, outcome]) =>
      caseResult(name, id, outcome, {
        ...(spec.cost?.[name] !== undefined ? { cost: spec.cost[name] } : {}),
        infra: spec.infra?.[name]?.includes(id) ?? false,
        judge: spec.judge !== undefined || spec.scoreIdentity !== undefined,
        ...(spec.scoreIdentity ? { identity: spec.scoreIdentity } : {}),
      })
    );
    const complete = caseResults.filter(
      (result) =>
        !result.trialResults?.some((trial) => trial.isInfrastructureError)
    );
    const incomplete = caseResults.length - complete.length;
    return {
      name,
      servers: [
        { transport: 'http', serverUrl: 'https://mcp.example/', label: name },
      ],
      result: {
        caseResults,
        total: caseResults.length,
        passed: complete.filter((r) => r.pass).length,
        failed: complete.filter((r) => !r.pass).length,
        ...(incomplete ? { incomplete } : {}),
        durationMs: 1,
      },
      metrics: {
        trial_pass_rate:
          Object.values(outcomes).reduce((s, [p, n]) => s + p / n, 0) /
          Object.values(outcomes).length,
        input_tokens_mean: 100,
        output_tokens_mean: 10,
        ...(spec.cost?.[name] !== undefined
          ? { cost_usd_mean: spec.cost[name] }
          : {}),
      },
      ...(spec.cost?.[name] !== undefined
        ? { costSource: 'client' as const }
        : {}),
    };
  });
  const results = variants.flatMap((v) => v.result.caseResults);
  const incomplete = variants.reduce(
    (sum, v) => sum + (v.result.incomplete ?? 0),
    0
  );
  const summary = {
    format: RUN_FORMAT,
    runId: spec.id,
    configId: 'weekly',
    contentHash: 'config-hash',
    timestamp: spec.at,
    durationMs: 1,
    configName: 'weekly',
    ...(spec.partial
      ? { partial: true, selection: { cases: ['a'] }, selectionHash: 'sel' }
      : {}),
    ...(spec.collectedAt ? { collectedAt: spec.collectedAt } : {}),
    ...(spec.grade === 'skipped' ? { graded: false as const } : {}),
    variants,
    metrics: { total: results.length, ...(incomplete ? { incomplete } : {}) },
    variantDeltas: {},
    results,
  } as unknown as EvaluationSummary;
  const caseIds = [
    ...new Set(Object.values(spec.variants).flatMap((o) => Object.keys(o))),
  ];
  const facts: RunFacts = {
    evalName: 'weekly',
    createdAt: spec.at,
    finishedAt: spec.at,
    mstVersion: '2.0.0',
    baseline: Object.keys(spec.variants)[0]!,
    variants: Object.keys(spec.variants).map((name) => ({
      name,
      servers: [{ label: name }],
      client: 'claude-code',
      model: spec.model?.[name] ?? 'claude-sonnet-4-6',
      // writeRun records every field a variant has, as runEval's do.
      ...(spec.setup?.[name] as Partial<RunFacts['variants'][number]>),
    })),
    ...(spec.plugins ? { plugins: spec.plugins } : {}),
    datasets: [
      {
        name: 'cases',
        caseCount: caseIds.length,
        contentHash: spec.datasetHash ?? `hash-${caseIds.length}`,
      },
    ],
    ...(spec.judge
      ? {
          judges: [
            {
              type: 'rubric',
              level: 'case',
              optionsHash: 'o',
              identity: createHash('sha256').update(spec.judge).digest('hex'),
            },
          ],
        }
      : {}),
    redactStoredResponses: true,
    ...(spec.simulateWrites ? { simulateWrites: true as const } : {}),
    ...(spec.gradedFrom ? { gradedFrom: spec.gradedFrom } : {}),
    phases: { collect: 'complete', grade: spec.grade ?? 'complete' },
  };
  await writeRun(
    path.join(evalDirectory, 'runs', spec.id),
    spec.id,
    facts,
    summary
  );
}

const ids = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `case-${i}`,
      [1, 1] as [number, number],
    ])
  );

/** Six weekly runs: a judge change in week 4, a partial run in week 5. */
async function weekly(evalDirectory: string): Promise<void> {
  const week = (n: number) => `2026-10-0${n}T09:00:00.000Z`;
  const run = (n: number) => `2026100${n}T090000Z-00000${n}`;
  for (const n of [1, 2, 3]) {
    const glean = ids(8);
    // Week 3: glean regresses on every case.
    if (n === 3) for (const id of Object.keys(glean)) glean[id] = [0, 1];
    await writeSpec(evalDirectory, {
      id: run(n),
      at: week(n),
      judge: 'j1',
      variants: { official: ids(8), glean },
      cost: { official: 0.02, glean: 0.01 * n },
    });
  }
  await writeSpec(evalDirectory, {
    id: run(4),
    at: week(4),
    judge: 'j2',
    variants: { official: ids(8), glean: ids(8) },
  });
  await writeSpec(evalDirectory, {
    id: run(5),
    at: week(5),
    judge: 'j2',
    partial: true,
    variants: { glean: { 'case-0': [0, 1] } },
  });
  await writeSpec(evalDirectory, {
    id: run(6),
    at: week(6),
    judge: 'j2',
    variants: { official: ids(9), glean: ids(9) },
  });
}

describe('the history of an eval', () => {
  it('has no chart on the page for what only runs off the charts measured', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const index = await buildHistory(localHistoryLocation(dir));
    // A judge only the newest run had.
    const [newest, ...rest] = index.runs;
    const judged = {
      ...newest!,
      variants: newest!.variants.map((variant) => ({
        ...variant,
        judges: {
          ...variant.judges,
          'x/judge/late': { trials: 2, passRate: 1 },
        },
      })),
    };
    const ids = (runs: HistoryIndex['runs']) =>
      metricsOf({ ...index, runs }).map((metric) => metric.id);
    expect(ids([judged, ...rest])).toContain('judge:x/judge/late');
    expect(ids([{ ...judged, partial: true }, ...rest])).not.toContain(
      'judge:x/judge/late'
    );
  });

  it('has a row per run, newest first, with eras where the judge or dataset changed', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const index = await updateHistory(localHistoryLocation(dir));
    expect(index.format).toBe(HISTORY_FORMAT);
    expect(index.runs.map((run) => run.runId.slice(-1))).toEqual([
      '6',
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    const [w6, w5, w4, w3, w2, w1] = index.runs;
    expect([w1!.era, w2!.era, w3!.era, w4!.era, w6!.era]).toEqual([
      0, 0, 0, 1, 2,
    ]);
    expect(w4!.changes).toEqual([
      { reason: 'judge changed: rubric', breaks: true },
    ]);
    expect(w6!.changes).toEqual([
      { reason: 'dataset cases changed', breaks: true },
      { reason: '1 case added', breaks: true },
    ]);
    // The partial run is kept, marked, and in no era.
    expect(w5).toMatchObject({ partial: true, selectionHash: 'sel' });
    expect(w5!.era).toBeUndefined();
    expect(isHistoryPoint(w5!)).toBe(false);
    // Written next to the runs.
    const written = JSON.parse(
      await fs.readFile(path.join(dir, 'history.json'), 'utf8')
    ) as HistoryIndex;
    expect(written.runs).toHaveLength(6);
    // With its page: the reporter UI and the history as data.js.
    for (const file of ['index.html', 'app.js', 'styles.css'])
      await expect(
        fs.stat(path.join(dir, 'history', file))
      ).resolves.toBeTruthy();
    const script = await fs.readFile(
      path.join(dir, 'history', 'data.js'),
      'utf8'
    );
    expect(script.startsWith('window.MST_HISTORY = ')).toBe(true);
    expect(
      (
        JSON.parse(
          script.replace(/^window\.MST_HISTORY = /, '').replace(/;\s*$/, '')
        ) as HistoryIndex
      ).runs
    ).toEqual(written.runs);
  });

  it("measures each variant against the previous run of its era, with the run's paired test", async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const index = await buildHistory(localHistoryLocation(dir));
    const glean = (n: number) =>
      index.runs
        .find((run) => run.runId.endsWith(`-00000${n}`))!
        .variants.find((variant) => variant.name === 'glean')!;
    expect(glean(1).sincePrevious).toBeUndefined();
    expect(glean(2).sincePrevious).toMatchObject({
      runId: '20261001T090000Z-000001',
      regressed: false,
      regressedCases: [],
    });
    expect(glean(3).sincePrevious).toMatchObject({
      passRateDelta: -1,
      regressed: true,
      change: { assessment: 'worse', cases: 8 },
    });
    expect(glean(3).sincePrevious!.regressedCases).toHaveLength(8);
    // A new era: nothing to compare with.
    expect(glean(4).sincePrevious).toBeUndefined();
    expect(glean(4).era).toBe(1);
    expect(glean(2)).toMatchObject({
      casePassRate: 1,
      trialPassRate: 1,
      costUsd: 0.02,
      costSource: 'client',
      tokens: { input: 100, output: 10 },
      judges: { rubric: { trials: 8, passRate: 1, meanScore: 1 } },
      durationMs: { p50: 1000, p95: 1000, mean: 1000 },
      outcomes: { 'case-0': [1, 1, 1] },
      setupHash: expect.any(String),
      servers: ['glean'],
    });
  });

  it('shows a regrade instead of the grading it replaces', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    const id = '20261001T090000Z-aaaaaa';
    await writeSpec(dir, {
      id,
      at: '2026-10-01T09:00:00.000Z',
      judge: 'j1',
      variants: { glean: ids(2) },
    });
    await writeSpec(dir, {
      id: `${id}.g2`,
      at: '2026-10-09T09:00:00.000Z',
      collectedAt: '2026-10-01T09:00:00.000Z',
      gradedFrom: id,
      judge: 'j2',
      variants: { glean: { 'case-0': [1, 1], 'case-1': [0, 1] } },
    });
    await writeSpec(dir, {
      id: '20261005T090000Z-bbbbbb',
      at: '2026-10-05T09:00:00.000Z',
      judge: 'j2',
      variants: { glean: ids(2) },
    });
    const index = await buildHistory(localHistoryLocation(dir));
    const original = index.runs.find((run) => run.runId === id)!;
    const regrade = index.runs.find((run) => run.runId === `${id}.g2`)!;
    expect(original.supersededBy).toBe(`${id}.g2`);
    expect(regrade).toMatchObject({
      collectedRunId: id,
      gradedFrom: id,
      gradings: [id],
      collectedAt: '2026-10-01T09:00:00.000Z',
    });
    // Ordered by collection, and graded by the newer judge: one era.
    expect(index.runs.map((run) => run.runId)).toEqual([
      '20261005T090000Z-bbbbbb',
      `${id}.g2`,
      id,
    ]);
    expect(index.runs[0]!.era).toBe(0);
    expect(index.runs[0]!.variants[0]!.sincePrevious).toMatchObject({
      runId: `${id}.g2`,
      improvedCases: ['case-1'],
    });
  });

  it('leaves out runs it cannot read and tool optimization runs, saying why', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await writeSpec(dir, {
      id: '20261001T090000Z-aaaaaa',
      at: '2026-10-01T09:00:00.000Z',
      variants: { glean: ids(1) },
    });
    const old = path.join(dir, 'runs', '20260901T090000Z-cccccc');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(
      path.join(old, 'run.json'),
      JSON.stringify({ runId: 'x', caseResults: [] })
    );
    // Not a run directory at all.
    await fs.mkdir(path.join(dir, 'runs', 'notes'), { recursive: true });
    const index = await buildHistory(localHistoryLocation(dir));
    expect(index.runs.map((run) => run.runId)).toEqual([
      '20261001T090000Z-aaaaaa',
    ]);
    expect(index.skipped).toEqual([
      {
        runId: '20260901T090000Z-cccccc',
        reason: expect.stringContaining('earlier MST'),
      },
    ]);
  });

  it('starts a variant’s era when it is added or its setup changes, and notes one that did not run', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await writeSpec(dir, {
      id: '20261001T090000Z-000001',
      at: '2026-10-01T09:00:00.000Z',
      variants: { official: ids(2), glean: ids(2) },
    });
    await writeSpec(dir, {
      id: '20261002T090000Z-000002',
      at: '2026-10-02T09:00:00.000Z',
      variants: { official: ids(2), glean: ids(2), plus: ids(2) },
      model: { glean: 'claude-opus-4-1' },
    });
    await writeSpec(dir, {
      id: '20261003T090000Z-000003',
      at: '2026-10-03T09:00:00.000Z',
      variants: { official: ids(2), plus: ids(2) },
      model: { glean: 'claude-opus-4-1' },
    });
    const [third, second] = await buildHistory(localHistoryLocation(dir)).then(
      (index) => index.runs
    );
    expect(second!.era).toBe(0);
    expect(second!.changes).toEqual([
      {
        reason: 'model claude-sonnet-4-6 → claude-opus-4-1',
        variant: 'glean',
        breaks: true,
      },
      { reason: 'variant added', variant: 'plus', breaks: true },
    ]);
    const era = (name: string) =>
      second!.variants.find((v) => v.name === name)!.era;
    expect([era('official'), era('glean'), era('plus')]).toEqual([0, 1, 0]);
    expect(
      second!.variants.find((v) => v.name === 'official')!.sincePrevious
    ).toBeDefined();
    expect(third!.changes).toEqual([
      { reason: 'variant not run', variant: 'glean', breaks: false },
    ]);
  });

  it('starts a new era for a variant that skipped the run where the dataset changed', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    const failing = {
      'case-0': [0, 1],
      'case-1': [0, 1],
    } as RunSpec['variants'][string];
    await writeSpec(dir, {
      id: '20261001T090000Z-000001',
      at: '2026-10-01T09:00:00.000Z',
      datasetHash: 'd1',
      variants: { official: ids(2), glean: ids(2) },
    });
    await writeSpec(dir, {
      id: '20261002T090000Z-000002',
      at: '2026-10-02T09:00:00.000Z',
      datasetHash: 'd2',
      variants: { official: ids(2) },
    });
    await writeSpec(dir, {
      id: '20261003T090000Z-000003',
      at: '2026-10-03T09:00:00.000Z',
      datasetHash: 'd2',
      variants: { official: ids(2), glean: failing },
    });
    const [third] = await buildHistory(localHistoryLocation(dir)).then(
      (index) => index.runs
    );
    const glean = third!.variants.find((v) => v.name === 'glean')!;
    // Not compared with week 1, which ran on the old dataset.
    expect(glean.era).toBe(1);
    expect(glean.sincePrevious).toBeUndefined();
    expect(third!.changes).toEqual([
      { reason: 'dataset cases changed', variant: 'glean', breaks: true },
    ]);
    const official = third!.variants.find((v) => v.name === 'official')!;
    expect(official.era).toBe(1);
    expect(official.sincePrevious?.runId).toBe('20261002T090000Z-000002');
  });

  it('names a change once when a returning variant also sees it in the run it returns to', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    for (const [n, hash, variants] of [
      [1, 'd1', { official: ids(2), glean: ids(2) }],
      [2, 'd2', { official: ids(2) }],
      [3, 'd3', { official: ids(2), glean: ids(2) }],
    ] as const)
      await writeSpec(dir, {
        id: `2026100${n}T090000Z-00000${n}`,
        at: `2026-10-0${n}T09:00:00.000Z`,
        datasetHash: hash,
        variants,
      });
    const [third] = await buildHistory(localHistoryLocation(dir)).then(
      (index) => index.runs
    );
    expect(third!.changes).toEqual([
      { reason: 'dataset cases changed', breaks: true },
    ]);
    expect(third!.variants.find((v) => v.name === 'glean')!.era).toBe(1);
  });

  it("starts a variant's era when a server's endpoint, a write mode or a hashed option changes", async () => {
    const dir = path.join(await tempDir(), 'weekly');
    const docs = (serverUrl: string) => [
      { label: 'docs', transport: 'http', serverUrl },
    ];
    const setups: Array<RunSpec['setup']> = [
      {
        glean: {
          servers: docs('https://a.example/mcp'),
          clientOptions: { url: 'hmac:1111' },
          writeModes: { docs: 'planned' },
        },
      },
      // The same: one era.
      {
        glean: {
          servers: docs('https://a.example/mcp'),
          clientOptions: { url: 'hmac:1111' },
          writeModes: { docs: 'planned' },
        },
      },
      {
        glean: {
          servers: docs('https://b.example/mcp'),
          clientOptions: { url: 'hmac:1111' },
          writeModes: { docs: 'planned' },
        },
      },
      {
        glean: {
          servers: docs('https://b.example/mcp'),
          clientOptions: { url: 'hmac:1111' },
          writeModes: { docs: 'unguarded' },
        },
      },
      // Hashed under another key, or another value: nothing shows it's the same.
      {
        glean: {
          servers: docs('https://b.example/mcp'),
          clientOptions: { url: 'hmac:2222' },
          writeModes: { docs: 'unguarded' },
        },
      },
    ];
    for (const [index, setup] of setups.entries())
      await writeSpec(dir, {
        id: `2026100${index + 1}T090000Z-00000${index + 1}`,
        at: `2026-10-0${index + 1}T09:00:00.000Z`,
        variants: { official: ids(2), glean: ids(2) },
        setup,
      });
    const runs = (await buildHistory(localHistoryLocation(dir))).runs.reverse();
    const glean = runs.map(
      (run) => run.variants.find((v) => v.name === 'glean')!
    );
    expect(glean.map((variant) => variant.era)).toEqual([0, 0, 1, 2, 3]);
    expect(glean[1]!.sincePrevious?.runId).toBe(runs[0]!.runId);
    expect(runs.map((run) => run.changes)).toEqual([
      undefined,
      undefined,
      [{ reason: 'server docs changed', variant: 'glean', breaks: true }],
      [
        {
          reason: 'write modes docs planned → docs unguarded',
          variant: 'glean',
          breaks: true,
        },
      ],
      [{ reason: 'client options changed', variant: 'glean', breaks: true }],
    ]);
    expect(glean[3]!.writeModes).toEqual({ docs: 'unguarded' });
    // The other variant's setup didn't change.
    expect(
      runs.map((run) => run.variants.find((v) => v.name === 'official')!.era)
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it("starts a variant's era when its scores' judge identity changes, a case judge's included", async () => {
    const dir = path.join(await tempDir(), 'weekly');
    const identity = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    for (const [n, judge] of [
      [1, 'prompt-1'],
      [2, 'prompt-1'],
      [3, 'prompt-2'],
    ] as const)
      await writeSpec(dir, {
        id: `2026100${n}T090000Z-00000${n}`,
        at: `2026-10-0${n}T09:00:00.000Z`,
        variants: { official: ids(2) },
        // No eval config judges: the identity is only on the scores.
        scoreIdentity: identity(judge),
      });
    const [third, second, first] = (
      await buildHistory(localHistoryLocation(dir))
    ).runs;
    expect(first!.variants[0]!.judges.rubric?.identities).toEqual([
      identity('prompt-1'),
    ]);
    expect([first, second, third].map((run) => run!.variants[0]!.era)).toEqual([
      0, 0, 1,
    ]);
    expect(third!.changes).toEqual([
      { reason: 'judge rubric changed', variant: 'official', breaks: true },
    ]);
  });

  it('starts an era when a plugin the eval loads changes version', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    const acme = (version: string) => [
      { namespace: 'acme', name: '@acme/mst-plugin', version },
    ];
    for (const [n, plugins] of [
      [1, undefined],
      [2, acme('1.0.0')],
      [3, acme('1.0.0')],
      [4, acme('1.1.0')],
    ] as const)
      await writeSpec(dir, {
        id: `2026100${n}T090000Z-00000${n}`,
        at: `2026-10-0${n}T09:00:00.000Z`,
        variants: { official: ids(2) },
        ...(plugins ? { plugins } : {}),
      });
    const runs = (await buildHistory(localHistoryLocation(dir))).runs.reverse();
    // A run from before run.json recorded plugins has nothing to compare.
    expect(runs.map((run) => run.era)).toEqual([0, 0, 0, 1]);
    expect(runs[3]!.changes).toEqual([
      { reason: 'plugin acme 1.0.0 → 1.1.0', breaks: true },
    ]);
    expect(runs[3]!.plugins).toEqual(acme('1.1.0'));
  });

  it('starts an era when writes go from planned-write results to simulated successes', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await writeSpec(dir, {
      id: '20261001T090000Z-000001',
      at: '2026-10-01T09:00:00.000Z',
      variants: { official: ids(2), glean: ids(2) },
    });
    await writeSpec(dir, {
      id: '20261002T090000Z-000002',
      at: '2026-10-02T09:00:00.000Z',
      simulateWrites: true,
      variants: { official: ids(2), glean: ids(2) },
    });
    const [second, first] = await buildHistory(localHistoryLocation(dir)).then(
      (index) => index.runs
    );
    expect(first!.simulateWrites).toBeUndefined();
    expect(second!.simulateWrites).toBe(true);
    expect([first!.era, second!.era]).toEqual([0, 1]);
    expect(second!.changes).toEqual([
      { reason: 'writes: planned → simulated', breaks: true },
    ]);
    expect(
      second!.variants.every((variant) => variant.sincePrevious === undefined)
    ).toBe(true);
  });

  it('counts infrastructure failures and incomplete cases, and never measures against an incomplete run', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await writeSpec(dir, {
      id: '20261001T090000Z-000001',
      at: '2026-10-01T09:00:00.000Z',
      variants: { glean: ids(4) },
      infra: { glean: ['case-0'] },
    });
    await writeSpec(dir, {
      id: '20261002T090000Z-000002',
      at: '2026-10-02T09:00:00.000Z',
      variants: { glean: ids(4) },
    });
    await writeSpec(dir, {
      id: '20261003T090000Z-000003',
      at: '2026-10-03T09:00:00.000Z',
      variants: { glean: ids(4) },
      grade: 'skipped',
    });
    const index = await buildHistory(localHistoryLocation(dir));
    const [ungraded, second, first] = index.runs;
    expect(first).toMatchObject({ status: 'incomplete' });
    expect(first!.variants[0]).toMatchObject({
      cases: 3,
      incomplete: 1,
      attempts: 5,
      infrastructureFailures: 1,
    });
    expect(first!.variants[0]!.outcomes['case-0']).toBeUndefined();
    expect(second!.variants[0]!.sincePrevious).toBeUndefined();
    expect(ungraded).toMatchObject({ status: 'ungraded' });
    expect(ungraded!.variants[0]!.casePassRate).toBeUndefined();
    expect(ungraded!.variants[0]!.outcomes).toEqual({});
  });

  it('reuses rows of runs that have not changed, and builds them all again on rebuild', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await writeSpec(dir, {
      id: '20261001T090000Z-000001',
      at: '2026-10-01T09:00:00.000Z',
      variants: { glean: ids(2) },
    });
    const location = localHistoryLocation(dir);
    await updateHistory(location);
    // The run's results change, its run.json doesn't: the row is cached.
    const results = path.join(
      dir,
      'runs',
      '20261001T090000Z-000001',
      'results.json'
    );
    const value = JSON.parse(await fs.readFile(results, 'utf8')) as {
      cases: Array<{ id: string }>;
    };
    value.cases = value.cases.slice(0, 1);
    await fs.writeFile(results, JSON.stringify(value));
    expect((await buildHistory(location)).runs[0]!.variants[0]!.cases).toBe(2);
    expect(
      (await updateHistory(location, { rebuild: true })).runs[0]!.variants[0]!
        .cases
    ).toBe(1);
    expect((await readHistory(location))!.runs[0]!.variants[0]!.cases).toBe(1);
  });

  it('derives the same rows whatever order it gets them in', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const index = await buildHistory(localHistoryLocation(dir));
    const again = deriveHistory([...index.runs].reverse());
    expect(again).toEqual(index.runs);
  });
});

/** A result store in memory. */
function memoryStore(): RunStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    location: 'memory://store',
    files,
    async put(key, body) {
      files.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    async get(key) {
      return files.get(key) ?? null;
    },
    async list(prefix, options = {}) {
      const keys = [...files.keys()].filter((key) => key.startsWith(prefix));
      if (!options.shallow) return keys;
      return [
        ...new Set(
          keys.map((key) => {
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            return slash === -1 ? key : `${prefix}${rest.slice(0, slash + 1)}`;
          })
        ),
      ];
    },
  };
}

describe('the history in a result store', () => {
  it("is built from the store's runs that finished uploading, and written beside latest.json", async () => {
    const local = path.join(await tempDir(), 'weekly');
    await weekly(local);
    const store = memoryStore();
    for (const runId of (await fs.readdir(path.join(local, 'runs'))).sort())
      await uploadRun(store, {
        evalName: 'weekly',
        runId,
        runDirectory: path.join(local, 'runs', runId),
      });
    // A run still uploading: files, no manifest.
    store.files.set(
      'weekly/runs/20261009T090000Z-999999/run.json',
      await fs.readFile(
        path.join(local, 'runs', '20261006T090000Z-000006', 'run.json')
      )
    );
    const index = await updateHistory(storeHistoryLocation(store, 'weekly'), {
      evalName: 'weekly',
    });
    expect(index.runs).toHaveLength(6);
    expect(index.evalName).toBe('weekly');
    const written = parseStored(store.files.get('weekly/history.json')!);
    expect(written.runs.map((run) => run.runId)).toEqual(
      index.runs.map((run) => run.runId)
    );
    // The page is in the store too, beside the runs it links to.
    expect(store.files.has('weekly/history/index.html')).toBe(true);
    expect(
      Buffer.from(store.files.get('weekly/history/data.js')!).toString('utf8')
    ).toMatch(/^window\.MST_HISTORY = \{"format":"mst\.history\/v1"/);
  });

  it('writes again when a run finished while it was writing', async () => {
    const local = path.join(await tempDir(), 'weekly');
    await weekly(local);
    const runIds = (await fs.readdir(path.join(local, 'runs'))).sort();
    const store = memoryStore();
    for (const runId of runIds.slice(0, 5))
      await uploadRun(store, {
        evalName: 'weekly',
        runId,
        runDirectory: path.join(local, 'runs', runId),
      });
    // Another coordinator uploads its run just as this one writes.
    const put = store.put.bind(store);
    let raced = false;
    store.put = async (key, body) => {
      await put(key, body);
      if (key === 'weekly/history.json' && !raced) {
        raced = true;
        await uploadRun(
          { ...store, put },
          {
            evalName: 'weekly',
            runId: runIds[5]!,
            runDirectory: path.join(local, 'runs', runIds[5]!),
          }
        );
      }
    };
    const index = await updateHistory(storeHistoryLocation(store, 'weekly'));
    expect(index.runs).toHaveLength(6);
    expect(
      parseStored(store.files.get('weekly/history.json')!).runs
    ).toHaveLength(6);
  });

  it("shows on the page what history.json holds when another writer finishes while it's writing the page", async () => {
    const local = path.join(await tempDir(), 'weekly');
    await weekly(local);
    const runIds = (await fs.readdir(path.join(local, 'runs'))).sort();
    const store = memoryStore();
    for (const runId of runIds.slice(0, 5))
      await uploadRun(store, {
        evalName: 'weekly',
        runId,
        runDirectory: path.join(local, 'runs', runId),
      });
    // While this writer copies the page's files, another uploads its run
    // and writes the history and page all the way.
    const put = store.put.bind(store);
    let raced = false;
    store.put = async (key, body) => {
      await put(key, body);
      if (key === 'weekly/history/index.html' && !raced) {
        raced = true;
        const other = { ...store, put };
        await uploadRun(other, {
          evalName: 'weekly',
          runId: runIds[5]!,
          runDirectory: path.join(local, 'runs', runIds[5]!),
        });
        await updateHistory(storeHistoryLocation(other, 'weekly'));
      }
    };
    await updateHistory(storeHistoryLocation(store, 'weekly'));
    const page = Buffer.from(store.files.get('weekly/history/data.js')!)
      .toString('utf8')
      .replace(/^window\.MST_HISTORY = /, '')
      .replace(/;\s*$/, '');
    const history = parseStored(store.files.get('weekly/history.json')!);
    expect(history.runs).toHaveLength(6);
    expect(JSON.parse(page)).toEqual(history);
  });

  it('writes again when a run it has a row for changed while it was writing', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const location = localHistoryLocation(dir);
    const newest = (await fs.readdir(path.join(dir, 'runs'))).sort().at(-1)!;
    const runFile = path.join(dir, 'runs', newest, 'run.json');
    const finished = await fs.readFile(runFile, 'utf8');
    // The newest run is partial until it resumes.
    const partial = JSON.parse(finished) as { phases: { collect: string } };
    partial.phases.collect = 'partial';
    await fs.writeFile(runFile, JSON.stringify(partial));
    // This writer pauses between history.json and the page's data; the
    // resume finishes and writes both meanwhile.
    let raced = false;
    const pausing = {
      ...location,
      store: {
        ...location.store,
        async put(key: string, body: string | Uint8Array) {
          if (key.endsWith('/history/data.js') && !raced) {
            raced = true;
            await fs.writeFile(runFile, finished);
            await updateHistory(location);
          }
          await location.store.put(key, body);
        },
      },
    };
    await updateHistory(pausing);
    const stored = parseStored(
      await fs.readFile(path.join(dir, 'history.json'))
    );
    const page = JSON.parse(
      (await fs.readFile(path.join(dir, 'history', 'data.js'), 'utf8'))
        .replace(/^window\.MST_HISTORY = /, '')
        .replace(/;\s*$/, '')
    ) as HistoryIndex;
    expect(stored.runs[0]!.phases.collect).toBe('complete');
    expect(page).toEqual(stored);
  });

  it("still writes history.json, with a warning, when the page can't be written", async () => {
    const local = path.join(await tempDir(), 'weekly');
    await weekly(local);
    const store = memoryStore();
    for (const runId of (await fs.readdir(path.join(local, 'runs'))).sort())
      await uploadRun(store, {
        evalName: 'weekly',
        runId,
        runDirectory: path.join(local, 'runs', runId),
      });
    const put = store.put.bind(store);
    store.put = async (key, body) => {
      if (key.startsWith('weekly/history/')) throw new Error('disk full');
      await put(key, body);
    };
    const warnings: string[] = [];
    const index = await updateHistory(storeHistoryLocation(store, 'weekly'), {
      warn: (message) => warnings.push(message),
    });
    expect(index.runs).toHaveLength(6);
    expect(
      parseStored(store.files.get('weekly/history.json')!).runs
    ).toHaveLength(6);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^\[mst\] The history page in .* wasn't written: disk full\. `mst open --history` writes it again\.$/
      ),
    ]);
  });

  it('replaces a local history.json in one step', async () => {
    const root = await tempDir();
    const store = fileRunStore(root);
    await store.put('e/history.json', '{"a":1}');
    await store.put('e/history.json', '{"a":2}');
    expect(await fs.readdir(path.join(root, 'e'))).toEqual(['history.json']);
    expect(
      await fs.readFile(path.join(root, 'e', 'history.json'), 'utf8')
    ).toBe('{"a":2}');
  });

  it('never lists a file a put left behind', async () => {
    const root = await tempDir();
    const store = fileRunStore(root);
    await store.put('e/runs/r/run.json', '{}');
    // As a put that crashed before its rename leaves it.
    await fs.writeFile(
      path.join(root, 'e', 'runs', 'r', 'run.json.mst-0a1b2c3d.tmp'),
      '{'
    );
    await fs.writeFile(path.join(root, 'e', 'notes.mst-0a1b2c3d.tmp'), '{');
    expect(await store.list('e/')).toEqual(['e/runs/r/run.json']);
    expect(await store.list('e/', { shallow: true })).toEqual(['e/runs/']);
  });
});

function parseStored(bytes: Uint8Array): HistoryIndex {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as HistoryIndex;
}

describe('mst history', () => {
  it('prints a table per variant with each change, era breaks and regressions', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const index = await buildHistory(localHistoryLocation(dir));
    const text = formatHistory(
      { ...index, runs: index.runs.filter((run) => !run.supersededBy) },
      { where: dir, limit: 20 }
    );
    expect(text).toContain('History of weekly: 6 runs, newest first');
    expect(text).toContain('official (baseline)');
    expect(text).toMatch(/000003 .*▼ −100 pts worse.*REGRESSED/);
    expect(text).toContain('── era 2 starts above: judge changed: rubric');
    expect(text).toContain(
      '── era 3 starts above: dataset cases changed; 1 case added'
    );
    expect(text).toMatch(/000005 .*\(partial\).*partial/);
    // The partial run isn't on the line: the era starts at the run after it.
    expect(text).toMatch(/glean\n.*\n.*000006 .*new era/);
    expect(text).toMatch(/000002 .*no change/);
    expect(text).toMatch(/Cost\/trial/);
    expect(text).toContain('$0.030');
  });

  /** What `mst history` printed, with its options. */
  async function printed(
    dir: string | undefined,
    options: Parameters<typeof history>[1]
  ): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await history(dir, options);
      return log.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      log.mockRestore();
    }
  }

  it('prints the runs it is asked for as JSON: --variant, --since and --limit', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const shown = JSON.parse(
      await printed(dir, {
        json: true,
        variant: ['glean'],
        since: '2026-10-02',
        limit: '2',
      })
    ) as HistoryIndex;
    expect(shown.format).toBe(HISTORY_FORMAT);
    expect(shown.runs.map((run) => run.runId.slice(-1))).toEqual(['6', '5']);
    expect(
      shown.runs.every(
        (run) => run.variants.length === 1 && run.variants[0]!.name === 'glean'
      )
    ).toBe(true);
    // Reading writes nothing.
    await expect(fs.access(path.join(dir, 'history.json'))).rejects.toThrow();
  });

  it('writes history.json with --rebuild, and says so', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    const text = await printed(dir, { rebuild: true });
    expect(text).toContain('History of weekly: 6 runs, newest first');
    expect(text).toContain(`Rebuilt the history.json of ${dir}.`);
    expect(
      (
        JSON.parse(
          await fs.readFile(path.join(dir, 'history.json'), 'utf8')
        ) as HistoryIndex
      ).runs
    ).toHaveLength(6);
  });

  it('refuses a bad --since or --limit, and a directory without runs', async () => {
    const dir = path.join(await tempDir(), 'weekly');
    await weekly(dir);
    await expect(printed(dir, { since: 'last week' })).rejects.toThrow(
      '--since "last week" isn\'t a date'
    );
    await expect(printed(dir, { limit: '0' })).rejects.toThrow(
      '--limit must be a whole number above 0'
    );
    const empty = await tempDir();
    await expect(printed(empty, {})).rejects.toThrow('it has no runs/');
  });
});
