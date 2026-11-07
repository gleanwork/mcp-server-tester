/**
 * An eval's history: one row per run, what it ran with and what it measured,
 * so quality and cost can be followed over time for each variant. It is
 * derived from the runs, never the other way round: `history.json` is a
 * cache in the eval's directory (and in a result store, beside
 * `latest.json`) that any process can rebuild from the runs it lists.
 *
 * ```text
 * <eval dir>/history.json   (format mst.history/v1)
 * ```
 *
 * Rows are kept per run directory, a regrade (`<run-id>.g<n>`) included: a
 * collection's newest complete grading supersedes its earlier gradings.
 * Consecutive full runs that measured with the same datasets, judges and
 * variant setups are one era; a change starts a new era, with the reasons,
 * and nothing before it is compared with anything after it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseChunked } from '@discoveryjs/json-ext';
import { z } from 'zod';
import type {
  EvaluationSummary,
  EvaluationVariantResult,
} from './evalFrameworkTypes.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type {
  HistoryChange,
  HistoryIndex,
  HistoryJudge,
  HistoryPairwise,
  HistoryRun,
  HistoryRunStatus,
  HistorySincePrevious,
  HistorySkippedRun,
  HistoryVariant,
} from '../types/history.js';
import type { GraderScore } from '../types/index.js';
import { assertRunFormat } from './resultFormat.js';
import {
  RUN_ID_PATTERN,
  RUN_SCHEMAS,
  joinCaseResults,
  runWithCurrentClients,
  summaryWithCurrentClients,
  type RunRecord,
} from './runFormat.js';
import { fileRunStore, hasStoredRun, type RunStore } from './runStore.js';
import {
  isCounted,
  isInfrastructure,
  isIncompleteCase,
} from './trialEnding.js';
import {
  DEFAULT_REGRESSION_TAG,
  caseTags,
  headlineGroup,
  headlinePassRate,
  measureAgainstBaseline,
} from './variantComparison.js';
import { wilson } from './judgeCheck.js';
import { reporterUiDirectory } from './runReport.js';

/** The history format. Readers ignore fields they don't know. */
export const HISTORY_FORMAT = 'mst.history/v1' as const;

/**
 * The version of the code that builds a row from a run. A cached row built
 * by another version is built again, so a row never mixes two definitions.
 */
const ROW_BUILDER = 1;

const HistoryIndexSchema = z.looseObject({
  format: z.literal(HISTORY_FORMAT),
  kind: z.literal('history'),
  evalName: z.string(),
  updatedAt: z.string(),
  runs: z.array(
    z.looseObject({
      runId: z.string().regex(RUN_ID_PATTERN),
      finishedAt: z.string(),
      builder: z.number(),
      variants: z.array(z.looseObject({ name: z.string() })),
    })
  ),
  skipped: z.array(z.looseObject({ runId: z.string(), reason: z.string() })),
});

/** Parses `history.json`; undefined when it isn't one this MST reads. */
function parseHistoryIndex(value: unknown): HistoryIndex | undefined {
  const parsed = HistoryIndexSchema.safeParse(value);
  return parsed.success ? (parsed.data as unknown as HistoryIndex) : undefined;
}

type Trial =
  | NonNullable<EvalCaseResult['trialResults']>[number]
  | EvalCaseResult;

function trialsOf(result: EvalCaseResult): Trial[] {
  return result.trialResults?.length ? result.trialResults : [result];
}

function sha(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex')
    .slice(0, 16);
}

function numberMetric(
  variant: EvaluationVariantResult,
  key: string
): number | undefined {
  const value = variant.metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function mean(values: number[]): number | undefined {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

/** The value at quantile `q` of sorted `values`, interpolated. */
function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/** Mean over cases of the mean over a case's trials, as MST's metrics are. */
function caseWeighted(
  cases: EvalCaseResult[],
  value: (trial: Trial) => number | undefined
): number | undefined {
  return mean(
    cases.flatMap((result) => {
      const values = trialsOf(result)
        .filter((trial) => !isInfrastructure(trial))
        .map(value)
        .filter((v): v is number => v !== undefined);
      const m = mean(values);
      return m === undefined ? [] : [m];
    })
  );
}

/** Each judge's verdict in a trial, by judge name. */
function judgeVerdicts(
  trial: Trial
): Array<{ name: string; score: GraderScore }> {
  const judge = (trial.scores as Partial<Record<string, GraderScore>>)?.judge;
  if (!judge) return [];
  if (judge.judgeResults?.length)
    return judge.judgeResults.map((score, index) => ({
      name: score.judgeName ?? `judge ${index + 1}`,
      score,
    }));
  return [{ name: judge.judgeName ?? 'judge', score: judge }];
}

function judgesOf(cases: EvalCaseResult[]): Record<string, HistoryJudge> {
  const tally = new Map<
    string,
    { trials: number; passed: number; unknown: number; scores: number[] }
  >();
  for (const result of cases)
    for (const trial of trialsOf(result)) {
      if (!isCounted(trial)) continue;
      for (const { name, score } of judgeVerdicts(trial)) {
        const entry = tally.get(name) ?? {
          trials: 0,
          passed: 0,
          unknown: 0,
          scores: [],
        };
        if (score.unknown === true) entry.unknown++;
        else {
          entry.trials++;
          if (score.pass) entry.passed++;
          if (typeof score.score === 'number') entry.scores.push(score.score);
        }
        tally.set(name, entry);
      }
    }
  return Object.fromEntries(
    [...tally].map(([name, entry]) => {
      const meanScore = mean(entry.scores);
      return [
        name,
        {
          trials: entry.trials,
          ...(entry.trials ? { passRate: entry.passed / entry.trials } : {}),
          ...(meanScore !== undefined ? { meanScore } : {}),
          ...(entry.unknown ? { unknown: entry.unknown } : {}),
        },
      ];
    })
  );
}

/** The key of a pairwise result: `<judge> vs variant:<name>`. */
function pairwiseKey(
  judge: string,
  reference: HistoryPairwise['reference']
): string {
  return `${judge} vs ${reference.runId ? `run:${reference.runId}/` : 'variant:'}${reference.variant}`;
}

function pairwiseOf(
  variant: EvaluationVariantResult
): Record<string, HistoryPairwise> {
  const pairwise = variant.pairwise;
  if (!pairwise) return {};
  return Object.fromEntries(
    pairwise.summary.map((judge) => {
      const reference = { variant: pairwise.baseline };
      // A tie is half a win, as the win rate counts it.
      const interval = wilson(
        judge.candidateWins + judge.ties / 2,
        judge.compared
      );
      return [
        pairwiseKey(judge.judge, reference),
        {
          judge: judge.judge,
          reference,
          compared: judge.compared,
          wins: judge.candidateWins,
          ties: judge.ties,
          losses: judge.baselineWins,
          errors: judge.errors,
          ...(judge.candidateWinRate !== undefined
            ? { winRate: judge.candidateWinRate }
            : {}),
          ...(interval.low !== null && interval.high !== null
            ? { low: interval.low, high: interval.high }
            : {}),
        },
      ];
    })
  );
}

/** A server as history names it: its label, else where it is. */
function serverName(server: Record<string, unknown>): string {
  const pick = (key: string) =>
    typeof server[key] === 'string' ? server[key] : undefined;
  return (
    pick('label') ??
    pick('serverUrl') ??
    pick('command') ??
    pick('connector') ??
    'server'
  );
}

/**
 * A variant's setup, as comparable across runs: an option value a run
 * recorded only as a keyed hash (`hmac:…`) can't be matched with another
 * run's, so only its name counts.
 */
function setupHashOf(
  record: RunRecord['variants'][number] | undefined
): string {
  const options = Object.fromEntries(
    Object.entries(record?.clientOptions ?? {}).map(([key, value]) => [
      key,
      typeof value === 'string' && value.startsWith('hmac:') ? 'hmac' : value,
    ])
  );
  return sha({
    client: record?.client,
    model: record?.model,
    options,
    servers: (record?.servers ?? []).map((server) =>
      serverName(server as Record<string, unknown>)
    ),
    tools: record?.tools,
    inputTemplate: record?.inputTemplate,
    judges: record?.judges,
  });
}

function clientAppsOf(cases: EvalCaseResult[]): string[] {
  const apps = new Set<string>();
  for (const result of cases)
    for (const telemetry of [
      result.clientTelemetry,
      ...(result.trialResults ?? []).map((trial) => trial.clientTelemetry),
    ]) {
      const app = telemetry?.clientApp as
        | { name?: unknown; version?: unknown }
        | undefined;
      if (typeof app?.name === 'string' && typeof app.version === 'string')
        apps.add(`${app.name} ${app.version}`);
    }
  return [...apps].sort();
}

function variantRow(
  variant: EvaluationVariantResult,
  record: RunRecord['variants'][number] | undefined,
  baseline: string,
  graded: boolean
): HistoryVariant {
  const cases = variant.result?.caseResults ?? [];
  const complete = cases.filter((result) => !isIncompleteCase(result));
  const incomplete = cases.length - complete.length;
  const attempts = cases.flatMap(trialsOf);
  const trials = attempts.filter((trial) => !isInfrastructure(trial));
  const durations = trials
    .map((trial) => trial.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
    .sort((a, b) => a - b);
  const outcomes: HistoryVariant['outcomes'] = {};
  if (graded)
    for (const result of complete) {
      const counted = trialsOf(result).filter(isCounted);
      outcomes[result.id] = [
        counted.filter((trial) => trial.pass).length,
        counted.length,
        result.pass ? 1 : 0,
      ];
    }
  const headline =
    graded && variant.result ? headlinePassRate(variant.result) : undefined;
  const tagged = (variant.result?.caseResults ?? []).some((result) =>
    caseTags(result).includes(DEFAULT_REGRESSION_TAG)
  );
  const cacheRead = caseWeighted(
    cases,
    (trial) => trial.clientUsage?.cacheReadInputTokens
  );
  const cacheCreation = caseWeighted(
    cases,
    (trial) => trial.clientUsage?.cacheCreationInputTokens
  );
  const input = numberMetric(variant, 'input_tokens_mean');
  const output = numberMetric(variant, 'output_tokens_mean');
  const tokens = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
  };
  const costUsd = numberMetric(variant, 'cost_usd_mean');
  const toolCalls = numberMetric(variant, 'tool_count_mean');
  const mcpCalls = numberMetric(variant, 'mcp_call_count_mean');
  const trialPassRate = numberMetric(variant, 'trial_pass_rate');
  const apps = clientAppsOf(cases);
  return {
    name: variant.name,
    baseline: variant.name === baseline,
    ...(record?.client ? { client: record.client } : {}),
    ...(record?.model ? { model: record.model } : {}),
    servers: (record?.servers ?? variant.servers ?? []).map((server) =>
      serverName(server as unknown as Record<string, unknown>)
    ),
    ...(apps.length ? { clientApps: apps } : {}),
    setupHash: setupHashOf(record),
    cases: complete.length,
    ...(incomplete ? { incomplete } : {}),
    ...(graded && complete.length
      ? {
          casePassRate:
            complete.filter((result) => result.pass).length / complete.length,
        }
      : {}),
    ...(graded && trialPassRate !== undefined ? { trialPassRate } : {}),
    ...(headline?.passRate !== undefined
      ? {
          headline: {
            group:
              tagged &&
              complete.every((result) =>
                caseTags(result).includes(DEFAULT_REGRESSION_TAG)
              )
                ? 'regression'
                : 'capability',
            cases: headline.cases,
            passRate: headline.passRate,
            ...(headline.interval
              ? { low: headline.interval.lower, high: headline.interval.upper }
              : {}),
          },
        }
      : {}),
    judges: graded ? judgesOf(cases) : {},
    pairwise: graded ? pairwiseOf(variant) : {},
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(variant.costSource ? { costSource: variant.costSource } : {}),
    ...(variant.unpricedModels?.length
      ? { unpricedModels: variant.unpricedModels }
      : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(durations.length
      ? {
          durationMs: {
            p50: quantile(durations, 0.5),
            p95: quantile(durations, 0.95),
            mean: mean(durations)!,
          },
        }
      : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(mcpCalls !== undefined ? { mcpCalls } : {}),
    attempts: attempts.length,
    infrastructureFailures: attempts.length - trials.length,
    clientErrors: trials.filter((trial) => trial.error !== undefined).length,
    outcomes,
  };
}

function statusOf(
  run: RunRecord,
  summary: EvaluationSummary
): HistoryRunStatus {
  if (run.phases.collect === 'failed') return 'failed';
  if (summary.graded === false || run.phases.grade === 'skipped')
    return 'ungraded';
  const incomplete = summary.metrics?.incomplete;
  if (
    run.phases.collect !== 'complete' ||
    run.phases.grade !== 'complete' ||
    (typeof incomplete === 'number' && incomplete > 0)
  )
    return 'incomplete';
  return 'complete';
}

/**
 * A run's history row, from its `run.json` and its summary with the case
 * results joined (`joinCaseResults`).
 */
function historyRunOf(run: RunRecord, summary: EvaluationSummary): HistoryRun {
  const status = statusOf(run, summary);
  const graded = status !== 'ungraded';
  const baseline = run.baseline ?? summary.variants[0]?.name ?? 'default';
  const all = summary.variants.flatMap(
    (variant) => variant.result?.caseResults ?? []
  );
  const caseIds = [...new Set(all.map((result) => result.id))].sort();
  const regression = [
    ...new Set(
      all
        .filter((result) => caseTags(result).includes(DEFAULT_REGRESSION_TAG))
        .map((result) => result.id)
    ),
  ].sort();
  const counts = all.map((result) => trialsOf(result).length);
  return {
    runId: run.runId,
    collectedRunId: run.runId.replace(/\.g\d+$/, ''),
    collectedAt: summary.collectedAt ?? summary.timestamp ?? run.finishedAt,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    status,
    phases: { collect: run.phases.collect, grade: run.phases.grade },
    partial: run.partial,
    ...(summary.selection ? { selection: summary.selection } : {}),
    ...(summary.selectionHash ? { selectionHash: summary.selectionHash } : {}),
    configId: run.configId,
    contentHash: run.contentHash,
    mstVersion: run.mst.version,
    ...(run.gradedFrom ? { gradedFrom: run.gradedFrom } : {}),
    ...(run.environment.name ? { environment: run.environment.name } : {}),
    baseline,
    datasets: run.datasets.map((dataset) => ({
      name: dataset.name,
      caseCount: dataset.caseCount,
      contentHash: dataset.contentHash,
      ...(dataset.type ? { type: dataset.type } : {}),
      ...(dataset.source ? { source: dataset.source } : {}),
      ...(dataset.snapshot ? { snapshot: dataset.snapshot } : {}),
    })),
    caseIds,
    caseIdsHash: sha(caseIds),
    ...(regression.length ? { regressionCases: regression } : {}),
    trialsPerCase: {
      min: counts.length ? Math.min(...counts) : 0,
      max: counts.length ? Math.max(...counts) : 0,
    },
    judges: (run.judges ?? []).map((judge) => ({
      type: judge.type,
      level: judge.level,
      ...(judge.identity ? { identity: judge.identity } : {}),
      optionsHash: judge.optionsHash,
    })),
    redacted: run.redactStoredResponses,
    variants: summary.variants.map((variant) =>
      variantRow(
        variant,
        run.variants.find((record) => record.name === variant.name),
        baseline,
        graded
      )
    ),
    builder: ROW_BUILDER,
  };
}

/** A variant's runner result rebuilt from its outcomes: enough for the paired test. */
function resultFromOutcomes(
  variant: HistoryVariant,
  regressionCases: ReadonlySet<string>
): EvalRunnerResult {
  const caseResults = Object.entries(variant.outcomes).map(
    ([id, [passed, trials, pass]]) =>
      ({
        id,
        datasetName: '',
        source: 'eval',
        pass: pass === 1,
        scores: {},
        durationMs: 0,
        ...(regressionCases.has(id) ? { tags: [DEFAULT_REGRESSION_TAG] } : {}),
        trialResults: Array.from({ length: trials }, (_, index) => ({
          pass: index < passed,
          durationMs: 0,
        })),
      }) as unknown as EvalCaseResult
  );
  return {
    caseResults,
    total: caseResults.length,
    passed: caseResults.filter((result) => result.pass).length,
    failed: caseResults.filter((result) => !result.pass).length,
    durationMs: 0,
  };
}

/** `variant` against the same variant in an earlier run, as `compareWithPrevious` tests it. */
function changeBetween(
  previous: { runId: string; run: HistoryRun; variant: HistoryVariant },
  current: { run: HistoryRun; variant: HistoryVariant }
): HistorySincePrevious {
  const regression = new Set([
    ...(previous.run.regressionCases ?? []),
    ...(current.run.regressionCases ?? []),
  ]);
  const change = headlineGroup(
    measureAgainstBaseline(
      resultFromOutcomes(previous.variant, regression),
      resultFromOutcomes(current.variant, regression),
      { grouping: { source: 'declared', tag: DEFAULT_REGRESSION_TAG } }
    )
  ).change;
  const regressedCases: string[] = [];
  const improvedCases: string[] = [];
  for (const [id, now] of Object.entries(current.variant.outcomes)) {
    const then = previous.variant.outcomes[id];
    if (!then) continue;
    if (then[2] === 1 && now[2] === 0) regressedCases.push(id);
    if (then[2] === 0 && now[2] === 1) improvedCases.push(id);
  }
  const delta = (a: number | undefined, b: number | undefined) =>
    a !== undefined && b !== undefined ? a - b : undefined;
  const passRateDelta = delta(
    current.variant.casePassRate,
    previous.variant.casePassRate
  );
  const trialPassRateDelta = delta(
    current.variant.trialPassRate,
    previous.variant.trialPassRate
  );
  return {
    runId: previous.runId,
    ...(passRateDelta !== undefined ? { passRateDelta } : {}),
    ...(trialPassRateDelta !== undefined ? { trialPassRateDelta } : {}),
    ...(change && change.cases > 0 ? { change } : {}),
    regressed: change?.assessment === 'worse',
    regressedCases: regressedCases.sort(),
    improvedCases: improvedCases.sort(),
  };
}

/** The eval-wide changes between two full runs: datasets and judges end an era. */
function evalChanges(before: HistoryRun, after: HistoryRun): HistoryChange[] {
  const changes: HistoryChange[] = [];
  const datasets = new Map(before.datasets.map((d) => [d.name, d]));
  for (const dataset of after.datasets) {
    const old = datasets.get(dataset.name);
    datasets.delete(dataset.name);
    if (!old) {
      changes.push({
        reason: `dataset added: ${dataset.name}`,
        breaks: true,
      });
      continue;
    }
    if (old.snapshot !== dataset.snapshot || old.source !== dataset.source)
      changes.push({
        reason: `dataset ${dataset.name}: ${old.source === 'live' ? 'live' : (old.snapshot ?? 'latest snapshot')} → ${dataset.source === 'live' ? 'live' : (dataset.snapshot ?? 'latest snapshot')}`,
        breaks: true,
      });
    else if (old.contentHash !== dataset.contentHash)
      changes.push({
        reason: `dataset ${dataset.name} changed`,
        breaks: true,
      });
  }
  for (const name of datasets.keys())
    changes.push({ reason: `dataset removed: ${name}`, breaks: true });
  const beforeIds = new Set(before.caseIds);
  const afterIds = new Set(after.caseIds);
  const added = after.caseIds.filter((id) => !beforeIds.has(id)).length;
  const removed = before.caseIds.filter((id) => !afterIds.has(id)).length;
  if (added || removed)
    changes.push({
      reason: [
        added ? `${added} ${added === 1 ? 'case' : 'cases'} added` : '',
        removed ? `${removed} ${removed === 1 ? 'case' : 'cases'} removed` : '',
      ]
        .filter(Boolean)
        .join(', '),
      breaks: true,
    });
  const judgeKey = (judge: HistoryRun['judges'][number]) =>
    `${judge.level}:${judge.type}`;
  const judgeId = (judge: HistoryRun['judges'][number]) =>
    judge.identity ?? judge.optionsHash;
  const judges = new Map(before.judges.map((j) => [judgeKey(j), j]));
  for (const judge of after.judges) {
    const old = judges.get(judgeKey(judge));
    judges.delete(judgeKey(judge));
    const kind = judge.level === 'pairwise' ? 'pairwise judge' : 'judge';
    if (!old)
      changes.push({ reason: `${kind} added: ${judge.type}`, breaks: true });
    else if (judgeId(old) !== judgeId(judge))
      changes.push({ reason: `${kind} changed: ${judge.type}`, breaks: true });
  }
  for (const judge of judges.values())
    changes.push({
      reason: `${judge.level === 'pairwise' ? 'pairwise judge' : 'judge'} removed: ${judge.type}`,
      breaks: true,
    });
  // Noted, not breaks: they don't change what a verdict means.
  if (
    before.trialsPerCase.min !== after.trialsPerCase.min ||
    before.trialsPerCase.max !== after.trialsPerCase.max
  )
    changes.push({
      reason: `trials per case: ${rangeText(before.trialsPerCase)} → ${rangeText(after.trialsPerCase)}`,
      breaks: false,
    });
  if (before.mstVersion !== after.mstVersion)
    changes.push({
      reason: `MST ${before.mstVersion} → ${after.mstVersion}`,
      breaks: false,
    });
  if (!changes.length && before.contentHash !== after.contentHash)
    changes.push({ reason: 'eval config changed', breaks: false });
  return changes;
}

function rangeText(range: { min: number; max: number }): string {
  return range.min === range.max
    ? String(range.max)
    : `${range.min}–${range.max}`;
}

function variantChanges(
  before: HistoryVariant | undefined,
  after: HistoryVariant
): HistoryChange[] {
  if (!before)
    return [{ reason: 'variant added', variant: after.name, breaks: true }];
  const changes: HistoryChange[] = [];
  if (before.setupHash !== after.setupHash) {
    const parts: string[] = [];
    if (before.client !== after.client)
      parts.push(`client ${before.client ?? '?'} → ${after.client ?? '?'}`);
    if (before.model !== after.model)
      parts.push(
        `model ${before.model ?? 'default'} → ${after.model ?? 'default'}`
      );
    if (before.servers.join(',') !== after.servers.join(','))
      parts.push(
        `servers ${before.servers.join(', ') || 'none'} → ${after.servers.join(', ') || 'none'}`
      );
    changes.push({
      reason: parts.length ? parts.join('; ') : 'setup changed',
      variant: after.name,
      breaks: true,
    });
  }
  const apps = (v: HistoryVariant) => (v.clientApps ?? []).join(', ');
  if (apps(before) !== apps(after) && apps(before) && apps(after))
    changes.push({
      reason: `client app ${apps(before)} → ${apps(after)}`,
      variant: after.name,
      breaks: false,
    });
  return changes;
}

/**
 * Whether a run is complete for one variant, so a later run can be compared
 * with it: the run collected and graded everything, and none of the
 * variant's cases is incomplete (another variant's may be).
 */
export function isCompleteFor(
  run: HistoryRun,
  variant: HistoryVariant
): boolean {
  return (
    (run.status === 'complete' || run.status === 'incomplete') &&
    run.phases.collect === 'complete' &&
    run.phases.grade === 'complete' &&
    !variant.incomplete
  );
}

/** Whether a row is a point of the history's lines: a full run's shown grading. */
export function isHistoryPoint(row: HistoryRun): boolean {
  return (
    !row.partial &&
    row.supersededBy === undefined &&
    (row.status === 'complete' || row.status === 'incomplete')
  );
}

/**
 * The index's rows with what follows from all of them: which gradings
 * supersede which, the eras, and each variant's change since the previous
 * complete run of its era. Newest first.
 */
export function deriveHistory(rows: HistoryRun[]): HistoryRun[] {
  const fresh = rows.map((row) => {
    const {
      supersededBy: _s,
      gradings: _g,
      era: _e,
      changes: _c,
      ...rest
    } = row;
    return {
      ...rest,
      variants: rest.variants.map(
        ({ era: _ve, sincePrevious: _p, ...variant }) => variant
      ),
    } as HistoryRun;
  });
  // A collection's newest grading that finished grading shows it.
  const byCollection = new Map<string, HistoryRun[]>();
  for (const row of fresh)
    byCollection.set(row.collectedRunId, [
      ...(byCollection.get(row.collectedRunId) ?? []),
      row,
    ]);
  const gradingNumber = (runId: string) =>
    Number(/\.g(\d+)$/.exec(runId)?.[1] ?? 1);
  for (const gradings of byCollection.values()) {
    if (gradings.length < 2) continue;
    gradings.sort((a, b) => gradingNumber(b.runId) - gradingNumber(a.runId));
    const shown =
      gradings.find((row) => row.status === 'complete') ??
      gradings.find((row) => row.status !== 'ungraded') ??
      gradings[0]!;
    for (const row of gradings)
      if (row !== shown) row.supersededBy = shown.runId;
    shown.gradings = gradings
      .filter((row) => row !== shown)
      .map((row) => row.runId)
      .sort();
  }
  const ordered = [...fresh].sort(
    (a, b) =>
      a.collectedAt.localeCompare(b.collectedAt) ||
      a.runId.localeCompare(b.runId)
  );
  let era = 0;
  let previous: HistoryRun | undefined;
  const variantEra = new Map<string, number>();
  const lastVariant = new Map<string, HistoryVariant>();
  const lastComplete = new Map<
    string,
    { run: HistoryRun; variant: HistoryVariant; era: number }
  >();
  for (const row of ordered) {
    if (!isHistoryPoint(row)) continue;
    const changes: HistoryChange[] = [];
    if (previous) {
      const evalWide = evalChanges(previous, row);
      changes.push(...evalWide);
      if (evalWide.some((change) => change.breaks)) era++;
    }
    for (const variant of row.variants) {
      const before = lastVariant.get(variant.name);
      const own = previous ? variantChanges(before, variant) : [];
      changes.push(...own);
      const breaks =
        before === undefined ||
        own.some((change) => change.breaks) ||
        changes.some((change) => change.breaks && !change.variant);
      const number = breaks
        ? (variantEra.get(variant.name) ?? -1) + 1
        : variantEra.get(variant.name)!;
      variantEra.set(variant.name, number);
      variant.era = number;
      lastVariant.set(variant.name, variant);
      const reference = lastComplete.get(variant.name);
      if (reference && reference.era === number)
        variant.sincePrevious = changeBetween(
          { runId: reference.run.runId, ...reference },
          { run: row, variant }
        );
      if (isCompleteFor(row, variant))
        lastComplete.set(variant.name, { run: row, variant, era: number });
    }
    if (previous)
      for (const name of previous.variants.map((v) => v.name))
        if (!row.variants.some((variant) => variant.name === name))
          changes.push({
            reason: 'variant not run',
            variant: name,
            breaks: false,
          });
    row.era = era;
    if (changes.length) row.changes = changes;
    previous = row;
  }
  return ordered.reverse();
}

/** Reads a JSON key from a store; undefined when absent. */
async function getJson(store: RunStore, key: string): Promise<unknown> {
  const bytes = await store.get(key);
  if (bytes === null) return undefined;
  const size = 16 * 1024 * 1024;
  return parseChunked(
    (function* () {
      for (let start = 0; start < bytes.length; start += size)
        yield bytes.subarray(start, start + size);
    })()
  );
}

/** Run `work` on every item, at most `limit` at a time. */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    })
  );
  return results;
}

/**
 * Where an eval's history lives: a store and the eval's key prefix in it.
 * A local eval directory is a file store over its parent, keyed by its
 * directory name; a result store is keyed by the eval's name.
 */
export interface HistoryLocation {
  store: RunStore;
  /** The eval's key in the store: its directory name, or its name. */
  evalKey: string;
  /** Whether the store copies runs with a manifest (a result store). */
  manifests: boolean;
}

/** The history location of a local eval directory. */
export function localHistoryLocation(evalDirectory: string): HistoryLocation {
  const resolved = path.resolve(evalDirectory);
  return {
    store: fileRunStore(path.dirname(resolved)),
    evalKey: path.basename(resolved),
    manifests: false,
  };
}

/** The history location of an eval in a result store. */
export function storeHistoryLocation(
  store: RunStore,
  evalName: string
): HistoryLocation {
  return { store, evalKey: evalName, manifests: true };
}

/** `history.json`'s key in its store. */
function historyKey(location: HistoryLocation): string {
  return `${location.evalKey}/history.json`;
}

/** The eval's history as last written, or undefined when there is none it can read. */
export async function readHistory(
  location: HistoryLocation
): Promise<HistoryIndex | undefined> {
  try {
    return parseHistoryIndex(
      await getJson(location.store, historyKey(location))
    );
  } catch {
    return undefined;
  }
}

/** One run's row, read from the store; a reason when the history leaves it out. */
async function readRow(
  location: HistoryLocation,
  runId: string,
  run: RunRecord
): Promise<HistoryRun | HistorySkippedRun> {
  const prefix = `${location.evalKey}/runs/${runId}/`;
  try {
    const summary = await getJson(location.store, `${prefix}summary.json`);
    if (summary === undefined)
      return { runId, reason: 'it has no summary.json' };
    assertRunFormat(summary, `${prefix}summary.json`);
    const results = (await getJson(location.store, `${prefix}results.json`)) as
      | { cases?: EvalCaseResult[] }
      | undefined;
    const joined = summaryWithCurrentClients(
      joinCaseResults(summary as EvaluationSummary, results?.cases ?? []),
      run
    );
    return historyRunOf(run, joined);
  } catch (error) {
    return {
      runId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Builds the eval's history from the runs the location lists, reusing each
 * cached row whose run hasn't changed since (same `finishedAt` and phases,
 * built by this MST's row builder); `rebuild` builds every row again.
 * Doesn't write.
 */
export async function buildHistory(
  location: HistoryLocation,
  options: { rebuild?: boolean; cached?: HistoryIndex; evalName?: string } = {}
): Promise<HistoryIndex> {
  const cached = options.rebuild
    ? undefined
    : (options.cached ?? (await readHistory(location)));
  const byId = new Map((cached?.runs ?? []).map((row) => [row.runId, row]));
  const runsPrefix = `${location.evalKey}/runs/`;
  const runIds = (await location.store.list(runsPrefix, { shallow: true }))
    .filter((key) => key.endsWith('/'))
    .map((key) => key.slice(runsPrefix.length, -1))
    .filter((id) => RUN_ID_PATTERN.test(id))
    .sort();
  const skipped: HistorySkippedRun[] = [];
  const rows = (
    await eachLimited(runIds, 8, async (runId) => {
      const key = `${runsPrefix}${runId}/run.json`;
      let run: RunRecord;
      try {
        const value = await getJson(location.store, key);
        if (value === undefined) return undefined;
        assertRunFormat(value, key);
        run = runWithCurrentClients(RUN_SCHEMAS.run.parse(value));
      } catch (error) {
        return {
          runId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (run.optimization) return { runId, reason: 'a tool optimization run' };
      const hit = byId.get(runId);
      if (
        hit &&
        hit.builder === ROW_BUILDER &&
        hit.finishedAt === run.finishedAt &&
        hit.phases?.collect === run.phases.collect &&
        hit.phases?.grade === run.phases.grade
      )
        return hit;
      // A stored run is there once its manifest is: before, it is uploading.
      if (
        location.manifests &&
        !(await hasStoredRun(location.store, location.evalKey, runId))
      )
        return undefined;
      return readRow(location, runId, run);
    })
  ).filter((row): row is HistoryRun | HistorySkippedRun => row !== undefined);
  const kept: HistoryRun[] = [];
  for (const row of rows)
    if ('builder' in row) kept.push(row);
    else skipped.push(row);
  return {
    format: HISTORY_FORMAT,
    kind: 'history',
    evalName: options.evalName ?? cached?.evalName ?? location.evalKey,
    updatedAt: new Date().toISOString(),
    runs: deriveHistory(kept),
    skipped,
  };
}

/** Writes `history.json`. A local file is replaced in one step. */
async function writeHistoryIndex(
  location: HistoryLocation,
  index: HistoryIndex
): Promise<void> {
  await location.store.put(historyKey(location), `${JSON.stringify(index)}\n`);
}

/**
 * Brings the eval's `history.json` up to date with its runs and writes it.
 * Two processes can finish runs at once, and a store has no compare-and-
 * swap, so after writing it lists the runs again and writes once more when
 * one appeared meanwhile. A history that still misses a run is rebuilt by
 * the next write or read: the runs are the truth, the index a cache.
 * The history page (`history/index.html`) is written from the index last.
 */
export async function updateHistory(
  location: HistoryLocation,
  options: { rebuild?: boolean; evalName?: string } = {}
): Promise<HistoryIndex> {
  let index = await buildHistory(location, options);
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeHistoryIndex(location, index);
    const again = await buildHistory(location, {
      cached: index,
      ...(options.evalName ? { evalName: options.evalName } : {}),
    });
    const known = new Set(index.runs.map((row) => row.runId));
    if (
      again.runs.length === index.runs.length &&
      again.runs.every((row) => known.has(row.runId))
    )
      break;
    index = again;
  }
  await writeHistoryPage(location, index);
  return index;
}

/**
 * Writes the history page into `<eval>/history/`: the reporter UI and the
 * history as `data.js`, so it opens from `file://` with nothing else. Its
 * links to runs' reports are relative (`../runs/<id>/report/index.html`).
 * The data holds no answers, tool outputs or reasoning: only IDs and
 * numbers, so a redacted run's history is as redacted as the run.
 */
async function writeHistoryPage(
  location: HistoryLocation,
  index: HistoryIndex
): Promise<void> {
  const ui = reporterUiDirectory();
  const prefix = `${location.evalKey}/history/`;
  const files = (await fs.readdir(ui, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  for (const file of files)
    await location.store.put(
      prefix + path.relative(ui, file).split(path.sep).join('/'),
      await fs.readFile(file)
    );
  await location.store.put(
    `${prefix}data.js`,
    `window.MST_HISTORY = ${JSON.stringify(index)};\n`
  );
}

/**
 * Brings the history up to date after a run is written, best effort: the
 * history is derived from the runs, so failing to write it never costs a
 * run its results. Returns the index, or undefined after a warning.
 */
export async function recordInHistory(
  location: HistoryLocation,
  evalName: string,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<HistoryIndex | undefined> {
  try {
    return await updateHistory(location, { evalName });
  } catch (error) {
    warn(
      `[mst] The eval's history in ${location.store.location} wasn't updated: ${error instanceof Error ? error.message : String(error)}. \`mst history --rebuild\` builds it again from the runs.`
    );
    return undefined;
  }
}

/** Whether a local eval directory holds runs: its `runs/` exists. */
export async function hasLocalRuns(evalDirectory: string): Promise<boolean> {
  return fs
    .stat(path.join(evalDirectory, 'runs'))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}
