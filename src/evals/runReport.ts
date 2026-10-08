/**
 * The report for one run: what `mst open` shows. Built from a run directory
 * (run.json, summary.json, results.json), so a report can be rebuilt from
 * the run alone, and written into the run's `report/` directory with the
 * reporter UI.
 */
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EvalCaseResult,
  MCPComparisonData,
  MCPRunReportData,
  RunReportDifference,
  RunReportPreference,
  RunReportScore,
  RunReportTrial,
  RunReportVariant,
  TrialResult,
} from '../types/reporter.js';
import type { GraderScore } from '../types/index.js';
import type { EvaluationVariantResult } from './evalFrameworkTypes.js';
import { RUN_FORMAT } from './resultFormat.js';
import {
  isInfraTrial,
  readRunDirectory,
  type RunRecord,
  type StoredRun,
} from './runFormat.js';
import { compareVariants } from './variantComparison.js';
import type { EvalRunnerResult, ToolMetadataOverride } from './evalRunner.js';

/** The tag that marks a regression case in an eval's datasets. */
const REGRESSION_TAG = 'regression';

/** Longest text kept for one event field, final answer or score detail. */
const MAX_TEXT = 4000;

function clip(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}… (${text.length - MAX_TEXT} more characters)`
    : text;
}

type Trial = TrialResult | EvalCaseResult;

function trialsOf(result: EvalCaseResult): Trial[] {
  return result.trialResults?.length ? result.trialResults : [result];
}

/**
 * A trial's scores, one per grader and one per judge. In a redacted run a
 * judge's reasoning and details are left out: they can quote the answer.
 */
function scoresOf(trial: Trial, redacted: boolean): RunReportScore[] {
  const scores = (trial as { scores?: Partial<Record<string, GraderScore>> })
    .scores;
  return Object.entries(scores ?? {}).flatMap(([grader, score]) => {
    if (!score) return [];
    const isJudge = grader === 'judge';
    const words = !(redacted && isJudge);
    const one = (name: string, s: GraderScore) => ({
      grader: name,
      ...(isJudge ? { judge: true } : {}),
      pass: s.pass,
      ...(typeof s.score === 'number' ? { score: s.score } : {}),
      ...(words && s.details ? { details: clip(s.details) } : {}),
      ...(words && s.reasoning ? { reasoning: clip(s.reasoning) } : {}),
    });
    if (grader === 'judge' && score.judgeResults?.length)
      return score.judgeResults.map((result, index) =>
        one(result.judgeName ?? `judge ${index + 1}`, result)
      );
    return [
      one(
        grader === 'judge' && score.judgeName ? score.judgeName : grader,
        score
      ),
    ];
  });
}

interface TraceEventLike {
  kind?: string;
  name?: string;
  server?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  text?: string;
}

function trialDetail(trial: Trial, redacted: boolean): RunReportTrial {
  const trace = (
    trial as {
      trace?: {
        events?: TraceEventLike[];
        finalText?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
      };
    }
  ).trace;
  const usage = trace?.usage;
  return {
    pass: trial.pass,
    ...(trial.error ? { error: clip(trial.error) } : {}),
    ...(isInfraTrial(trial) ? { infrastructureError: true } : {}),
    ...(trial.durationMs !== undefined ? { durationMs: trial.durationMs } : {}),
    ...(trace?.finalText ? { finalText: clip(trace.finalText) } : {}),
    events: (trace?.events ?? []).map((event) => ({
      kind: event.kind ?? 'event',
      ...(event.name ? { name: event.name } : {}),
      ...(event.server ? { server: event.server } : {}),
      ...(event.arguments !== undefined || event.input !== undefined
        ? { input: clip(event.arguments ?? event.input) }
        : {}),
      ...(event.output !== undefined ? { output: clip(event.output) } : {}),
      ...(event.text ? { text: clip(event.text) } : {}),
      ...(event.isError ? { isError: true } : {}),
    })),
    scores: scoresOf(trial, redacted),
    ...(usage &&
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
      ? {
          tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      : {}),
  };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number | undefined {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

function numberMetric(
  variant: EvaluationVariantResult,
  key: string
): number | undefined {
  const value = variant.metrics?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Which tools (or servers, when the run has several) a variant's trials called, by share of calls. */
function toolsUsed(
  details: RunReportTrial[],
  byServer: boolean
): RunReportVariant['toolsUsed'] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const trial of details)
    for (const event of trial.events) {
      if (event.kind !== 'tool_call') continue;
      const key = byServer
        ? (event.server ?? event.name ?? 'unknown')
        : (event.name ?? 'unknown');
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, share: count / total }));
}

function text(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Each setup field where a variant differs from the baseline. */
function differences(
  baseline: RunRecord['variants'][number] | undefined,
  variant: RunRecord['variants'][number]
): RunReportDifference[] {
  if (!baseline) return [];
  const rows: RunReportDifference[] = [];
  const compare = (field: string, a: unknown, b: unknown) => {
    const before = text(a);
    const after = text(b);
    if (before !== after)
      rows.push({
        field,
        ...(before !== undefined ? { baseline: before } : {}),
        ...(after !== undefined ? { variant: after } : {}),
      });
  };
  compare('client', baseline.client, variant.client);
  compare('model', baseline.model, variant.model);
  const labels = (v: typeof variant) =>
    (v.servers ?? [])
      .map((server) => (server as { label?: string }).label ?? '(unlabelled)')
      .join(', ') || undefined;
  compare('servers', labels(baseline), labels(variant));
  const options = new Set([
    ...Object.keys(baseline.clientOptions ?? {}),
    ...Object.keys(variant.clientOptions ?? {}),
  ]);
  for (const key of [...options].sort())
    compare(
      `clientOptions.${key}`,
      baseline.clientOptions?.[key],
      variant.clientOptions?.[key]
    );
  // Tool metadata the baseline changes and the variant doesn't.
  const variantTools = variant.tools ?? {};
  for (const tool of Object.keys(baseline.tools ?? {}).sort())
    if (!(tool in variantTools))
      compare(
        `tools.${tool}`,
        (baseline.tools as Record<string, unknown>)[tool],
        "the server's own"
      );
  compare('inputTemplate', baseline.inputTemplate, variant.inputTemplate);
  compare('judges', baseline.judges?.join(', '), variant.judges?.join(', '));
  // Tool metadata changes are shown as diffs from the comparison's tool changes.
  return rows;
}

/** The tools a variant changes, as the overrides compareVariants diffs. */
function toolOverrides(
  variant: RunRecord['variants'][number] | undefined
): Record<string, ToolMetadataOverride> {
  const tools = variant?.tools as
    | Record<string, ToolMetadataOverride>
    | undefined;
  return tools ?? {};
}

function emptyResult(): EvalRunnerResult {
  return { total: 0, passed: 0, failed: 0, caseResults: [], durationMs: 0 };
}

/**
 * The report data for a run: computed here, so the UI only renders it.
 * Variants are compared with the eval's baseline case by case; when a
 * narrowed run left the baseline out, the first variant that ran is the
 * reference.
 */
export function buildRunReport(stored: StoredRun): MCPRunReportData {
  const { run, summary } = stored;
  const ran = summary.variants;
  const baselineName = run.baseline ?? ran[0]?.name ?? 'default';
  const baseline = ran.find((v) => v.name === baselineName) ?? ran[0];
  const candidates = ran.filter((v) => v !== baseline);
  const recordOf = (name: string) =>
    run.variants.find((variant) => variant.name === name);
  const baselineRecord = baseline ? recordOf(baseline.name) : undefined;

  const comparison: MCPComparisonData = compareVariants({
    baseline: baseline?.result ?? emptyResult(),
    candidates: candidates.map((variant) => {
      const record = recordOf(variant.name);
      const tools = toolOverrides(record);
      const baseTools = toolOverrides(baselineRecord);
      const changed = Object.fromEntries(
        Object.entries(tools).filter(
          ([name, value]) =>
            JSON.stringify(value) !== JSON.stringify(baseTools[name])
        )
      );
      return {
        id: variant.name,
        result: variant.result ?? emptyResult(),
        ...(record?.description ? { description: record.description } : {}),
        ...(Object.keys(changed).length ? { tools: changed } : {}),
      };
    }),
    regressionCheck: 'significant',
    grouping: { source: 'declared', tag: REGRESSION_TAG },
    originalTools: toolOverrides(baselineRecord),
    purpose: 'eval',
    ...(baseline ? { baselineName: baseline.name } : {}),
  });
  // The comparison names the baseline by an internal ID; the report uses its name.
  const comparisonBaselineId = comparison.baselineId;

  const servers = new Set(
    ran.flatMap((variant) =>
      (variant.result?.caseResults ?? []).flatMap((result) =>
        trialsOf(result).flatMap(
          (trial) =>
            (trial as { trace?: { events?: TraceEventLike[] } }).trace?.events
              ?.filter((event) => event.kind === 'tool_call' && event.server)
              .map((event) => event.server) ?? []
        )
      )
    )
  );

  const trials: MCPRunReportData['trials'] = {};
  const preferences: MCPRunReportData['preferences'] = {};
  const variants: RunReportVariant[] = ran.map((variant) => {
    const isBaseline = variant === baseline;
    const id = isBaseline ? comparisonBaselineId : variant.name;
    const record = recordOf(variant.name);
    const byCase: Record<string, RunReportTrial[]> = {};
    for (const result of variant.result?.caseResults ?? [])
      byCase[result.id] = trialsOf(result).map((trial) =>
        trialDetail(trial, run.redactStoredResponses)
      );
    trials[id] = byCase;
    // Infrastructure failures say nothing about the variant.
    const details = Object.values(byCase)
      .flat()
      .filter((trial) => !trial.infrastructureError);
    // One mean per judge: judges score on their own scales.
    const byJudge = new Map<string, number[]>();
    for (const trial of details)
      for (const score of trial.scores)
        if (score.judge && typeof score.score === 'number')
          byJudge.set(score.grader, [
            ...(byJudge.get(score.grader) ?? []),
            score.score,
          ]);
    const durations = details
      .map((trial) => trial.durationMs)
      .filter((value): value is number => value !== undefined);
    const entry = comparison.variants.find((v) => v.id === id);
    const pairwise = variant.pairwise;
    if (pairwise) {
      const prefs: Record<string, RunReportPreference[]> = {};
      for (const row of pairwise.cases)
        prefs[row.id] = row.preferences.map((p) => {
          const preference = p as unknown as {
            judge: string;
            preference?: string;
            reasoning?: string;
            error?: string;
          };
          return {
            judge: preference.judge,
            preference: preference.preference ?? 'none',
            // A pairwise judge's reasoning can quote both answers.
            ...(preference.reasoning && !run.redactStoredResponses
              ? { reasoning: clip(preference.reasoning) }
              : {}),
            ...(preference.error ? { error: clip(preference.error) } : {}),
          };
        });
      preferences[id] = prefs;
    }
    const passRate = variant.result
      ? variant.result.total
        ? variant.result.passed / variant.result.total
        : undefined
      : undefined;
    return {
      id,
      name: variant.name,
      baseline: isBaseline,
      ...(record?.description ? { description: record.description } : {}),
      ...(record?.client ? { client: record.client } : {}),
      ...(record?.model ? { model: record.model } : {}),
      verdict: isBaseline ? 'baseline' : verdictOf(entry),
      ...(passRate !== undefined ? { casePassRate: passRate } : {}),
      ...(numberMetric(variant, 'trial_pass_rate') !== undefined
        ? { trialPassRate: numberMetric(variant, 'trial_pass_rate') }
        : {}),
      judgeScores: [...byJudge].map(([judge, scores]) => ({
        judge,
        mean: mean(scores)!,
      })),
      ...(numberMetric(variant, 'cost_usd_mean') !== undefined
        ? { costPerCase: numberMetric(variant, 'cost_usd_mean') }
        : {}),
      ...(median(durations) !== undefined
        ? { medianDurationMs: median(durations) }
        : {}),
      toolsUsed: toolsUsed(details, servers.size > 1),
      pairwise: (pairwise?.summary ?? []).map((judge) => ({
        judge: judge.judge,
        compared: judge.compared,
        wins: judge.candidateWins,
        losses: judge.baselineWins,
        ties: judge.ties,
        errors: judge.errors,
        ...(judge.candidateWinRate !== undefined
          ? { winRate: judge.candidateWinRate }
          : {}),
      })),
      ...(summary.previousRun?.variants[variant.name]
        ? { previous: summary.previousRun.variants[variant.name] }
        : {}),
    };
  });

  const counts = comparison.cases.flatMap((row) =>
    Object.values(row.trials).map((list) => list.length)
  );
  return {
    format: RUN_FORMAT,
    kind: 'report',
    run: {
      runId: run.runId,
      evalName: run.evalName,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      mstVersion: run.mst.version,
      partial: run.partial,
      redacted: run.redactStoredResponses,
      ...(run.selection ? { selection: run.selection } : {}),
      baseline: baselineName,
      baselineRan: baseline?.name === baselineName,
      datasets: run.datasets.map(({ name, caseCount }) => ({
        name,
        caseCount,
      })),
      // Cases any variant ran; the grid shows the ones the baseline ran.
      cases: new Set(
        ran.flatMap((v) => (v.result?.caseResults ?? []).map((r) => r.id))
      ).size,
      trialsPerCase: {
        min: counts.length ? Math.min(...counts) : 0,
        max: counts.length ? Math.max(...counts) : 0,
      },
    },
    comparison,
    variants,
    differences: Object.fromEntries(
      candidates.map((variant) => [
        variant.name,
        differences(
          baselineRecord,
          recordOf(variant.name) ?? { name: variant.name }
        ),
      ])
    ),
    trials,
    preferences,
    ...(summary.previousRun
      ? {
          previousRun: {
            runId: summary.previousRun.runId,
            timestamp: summary.previousRun.timestamp,
            sameConfig: summary.previousRun.sameConfig,
            passRate: summary.previousRun.passRate,
            passRateDelta: summary.previousRun.passRateDelta,
          },
        }
      : {}),
  };
}

/** Clearly better, clearly worse, or unclear, from the paired tests. */
function verdictOf(
  entry: MCPComparisonData['variants'][number] | undefined
): RunReportVariant['verdict'] {
  if (!entry) return 'unclear';
  if (
    entry.regression.change?.assessment === 'worse' ||
    entry.brokenCaseIds.length > 0 ||
    entry.capability.change?.assessment === 'worse'
  )
    return 'worse';
  if (entry.capability.change?.assessment === 'better') return 'better';
  // Every case tagged regression: the regression group decides.
  if (
    entry.capability.cases === 0 &&
    entry.regression.change?.assessment === 'better'
  )
    return 'better';
  return 'unclear';
}

/** The built reporter UI: in the package's dist, or in src when running from source. */
function reporterUiDirectory(): string {
  const here =
    typeof __filename === 'string'
      ? __filename
      : fileURLToPath(import.meta.url);
  // Running from source (tests, tsx) uses the UI built into src.
  const fromSource = here.split(path.sep).includes('src');
  let directory = path.dirname(here);
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
      };
      if (name === '@gleanwork/mcp-server-tester') {
        const built = path.join(directory, 'dist', 'reporters', 'ui-dist');
        const source = path.join(directory, 'src', 'reporters', 'ui-dist');
        for (const candidate of fromSource ? [source, built] : [built, source])
          if (existsSync(path.join(candidate, 'app.js'))) return candidate;
        throw new Error(
          'The reporter UI is not built. Run `npm run build` in @gleanwork/mcp-server-tester.'
        );
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error('Cannot find the @gleanwork/mcp-server-tester package.');
    directory = parent;
  }
}

/** Where a run's report is: `<run>/report/index.html`. */
export function runReportPath(runDirectory: string): string {
  return path.join(runDirectory, 'report', 'index.html');
}

/**
 * Write a run's report into `<run>/report/`: the reporter UI and the
 * report data. Returns the report's index.html.
 */
export async function writeRunReport(
  runDirectory: string,
  data?: MCPRunReportData
): Promise<string> {
  const report = data ?? buildRunReport(await readRunDirectory(runDirectory));
  const target = path.join(runDirectory, 'report');
  await fs.mkdir(target, { recursive: true });
  await fs.cp(reporterUiDirectory(), target, { recursive: true, force: true });
  await fs.writeFile(
    path.join(target, 'data.js'),
    `window.MST_RUN_REPORT = ${JSON.stringify(report)};\n`,
    'utf8'
  );
  return runReportPath(runDirectory);
}
