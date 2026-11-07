/**
 * `mst history`: an eval's runs over time, one table per variant, newest
 * first, with each run's change since the previous comparable run and where
 * an era starts.
 */
import path from 'node:path';
import { evalResultStore } from '../../../evals/runEval.js';
import {
  buildHistory,
  hasLocalRuns,
  isCompleteFor,
  isHistoryPoint,
  localHistoryLocation,
  storeHistoryLocation,
  updateHistory,
  type HistoryLocation,
} from '../../../evals/runHistory.js';
import type {
  HistoryIndex,
  HistoryRun,
  HistoryVariant,
} from '../../../types/history.js';

export interface HistoryOptions {
  /** The eval config: its name finds its runs. */
  config?: string;
  rootDir?: string;
  /** The eval's directory, if `mst run` was given `--output-dir`. */
  outputDir?: string;
  /** A result store, instead of the eval config's. */
  results?: string;
  /** Only these variants. */
  variant?: string[];
  /** Only runs collected on or after this date. */
  since?: string;
  /** Most runs per variant. Default 20. */
  limit?: string;
  json?: boolean;
  /** Build every row again from the runs, and write history.json. */
  rebuild?: boolean;
}

/** Where the eval's runs are: an eval directory, or the eval config's store or local directory. */
async function locate(
  evalDirectory: string | undefined,
  options: HistoryOptions
): Promise<{ location: HistoryLocation; evalName: string; where: string }> {
  if (evalDirectory !== undefined) {
    const directory = path.resolve(evalDirectory);
    if (!(await hasLocalRuns(directory)))
      throw new Error(
        `${directory} isn't an eval's directory: it has no runs/. Give an eval's directory (.mcp-test-results/<eval name>) or --config.`
      );
    return {
      location: localHistoryLocation(directory),
      evalName: path.basename(directory),
      where: directory,
    };
  }
  if (!options.config)
    throw new Error(
      "Give an eval's directory (mst history .mcp-test-results/<eval name>) or its eval config (--config)."
    );
  const rootDir = path.resolve(options.rootDir ?? '.');
  const { evalName, store } = await evalResultStore({
    configPath: options.config,
    rootDir,
    ...(options.results ? { results: options.results } : {}),
  });
  if (store)
    return {
      location: storeHistoryLocation(store, evalName),
      evalName,
      where: store.location,
    };
  const directory = path.resolve(
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', evalName)
  );
  return {
    location: localHistoryLocation(directory),
    evalName,
    where: directory,
  };
}

function percent(share: number | undefined): string {
  return share === undefined ? '—' : `${(share * 100).toFixed(0)}%`;
}

function signedPoints(share: number): string {
  const x = share * 100;
  return `${x > 0.05 ? '+' : x < -0.05 ? '−' : '±'}${Math.abs(x).toFixed(Math.abs(x) < 10 && Math.abs(x) % 1 > 0.05 ? 1 : 0)}`;
}

function tokensText(variant: HistoryVariant): string {
  const tokens = variant.tokens;
  if (!tokens || (tokens.input === undefined && tokens.output === undefined))
    return '—';
  const total = (tokens.input ?? 0) + (tokens.output ?? 0);
  return total >= 1000
    ? `${(total / 1000).toFixed(1)}k`
    : String(Math.round(total));
}

function sinceText(variant: HistoryVariant, eraStart: boolean): string {
  const since = variant.sincePrevious;
  if (!since) return eraStart ? 'new era' : '—';
  const change = since.change;
  if (!change)
    return since.passRateDelta === undefined
      ? '—'
      : `${signedPoints(since.passRateDelta)} pts`;
  if (change.upper - change.lower < 0.0005 && Math.abs(change.mean) < 0.0005)
    return 'no change';
  const arrow =
    change.assessment === 'better'
      ? '▲'
      : change.assessment === 'worse'
        ? '▼'
        : ' ';
  return `${arrow} ${signedPoints(change.mean)} pts ${change.assessment}`;
}

/** What marks a row: why it isn't a plain point. */
function flags(run: HistoryRun, variant: HistoryVariant): string {
  const marks: string[] = [];
  if (run.partial) marks.push('partial');
  if (run.status === 'ungraded' || run.status === 'failed')
    marks.push(run.status);
  else if (variant.incomplete)
    marks.push(
      `${variant.incomplete} ${variant.incomplete === 1 ? 'case' : 'cases'} incomplete`
    );
  else if (!isCompleteFor(run, variant)) marks.push('incomplete');
  if (run.gradedFrom) marks.push('regrade');
  if (variant.sincePrevious?.regressed) marks.push('REGRESSED');
  if (variant.unpricedModels?.length) marks.push('unpriced');
  return marks.join(', ');
}

/** The eval's history, filtered as asked. */
function filtered(index: HistoryIndex, options: HistoryOptions): HistoryIndex {
  const since = options.since ? Date.parse(options.since) : undefined;
  if (since !== undefined && Number.isNaN(since))
    throw new Error(`--since "${options.since}" isn't a date (2026-10-01).`);
  const wanted = options.variant?.length ? new Set(options.variant) : undefined;
  return {
    ...index,
    runs: index.runs
      .filter((run) => run.supersededBy === undefined)
      .filter(
        (run) => since === undefined || Date.parse(run.collectedAt) >= since
      )
      .map((run) =>
        wanted
          ? {
              ...run,
              variants: run.variants.filter((v) => wanted.has(v.name)),
            }
          : run
      )
      .filter((run) => run.variants.length > 0),
  };
}

/** A plugin judge's name without its namespace and kind: `acme/judge/quality` is `quality`. */
function shortName(name: string): string {
  return name.replace(/^[^/\s]+\/(judge|pairwise-judge)\//, '');
}

/** The table of one variant's runs, newest first, with era markers. */
function variantTable(
  index: HistoryIndex,
  name: string,
  limit: number
): string[] {
  const rows = index.runs
    .flatMap((run) => {
      const variant = run.variants.find((v) => v.name === name);
      return variant ? [{ run, variant }] : [];
    })
    .slice(0, limit);
  if (!rows.length) return [];
  const judges = [
    ...new Set(rows.flatMap(({ variant }) => Object.keys(variant.judges))),
  ];
  const pairwise = [
    ...new Set(rows.flatMap(({ variant }) => Object.keys(variant.pairwise))),
  ];
  const header = [
    'Run',
    'Collected (UTC)',
    'Cases',
    'Trials',
    'Since previous',
    ...judges.map(shortName),
    ...pairwise.map((key) => shortName(key.replace(/ vs variant:/, ' vs '))),
    'Cost/trial',
    'Tokens/trial',
    'p50',
    'p95',
    'Infra',
    '',
  ];
  const table: Array<string[] | string> = [];
  for (const [position, { run, variant }] of rows.entries()) {
    // The next older point of the line: partial runs aren't on it.
    const older = rows
      .slice(position + 1)
      .find((row) => isHistoryPoint(row.run));
    const eraStart =
      isHistoryPoint(run) &&
      older !== undefined &&
      older.variant.era !== variant.era;
    table.push([
      run.runId.slice(run.runId.lastIndexOf('-') + 1),
      run.collectedAt.slice(0, 16).replace('T', ' '),
      percent(variant.casePassRate),
      percent(variant.trialPassRate),
      run.partial ? '(partial)' : sinceText(variant, eraStart),
      ...judges.map((judge) => {
        const result = variant.judges[judge];
        if (!result) return '—';
        return result.passRate !== undefined
          ? percent(result.passRate)
          : result.meanScore !== undefined
            ? result.meanScore.toFixed(2)
            : '—';
      }),
      ...pairwise.map((key) => {
        const result = variant.pairwise[key];
        if (result?.winRate === undefined) return '—';
        return result.low !== undefined && result.high !== undefined
          ? `${percent(result.winRate)} (${(result.low * 100).toFixed(0)}–${(result.high * 100).toFixed(0)})`
          : percent(result.winRate);
      }),
      variant.costUsd === undefined ? '—' : `$${variant.costUsd.toFixed(3)}`,
      tokensText(variant),
      variant.durationMs
        ? `${(variant.durationMs.p50 / 1000).toFixed(1)} s`
        : '—',
      variant.durationMs
        ? `${(variant.durationMs.p95 / 1000).toFixed(1)} s`
        : '—',
      variant.attempts
        ? percent(variant.infrastructureFailures / variant.attempts)
        : '—',
      flags(run, variant),
    ]);
    if (eraStart) {
      const reasons = (run.changes ?? [])
        .filter(
          (change) =>
            change.breaks &&
            (change.variant === undefined || change.variant === name)
        )
        .map((change) => change.reason);
      table.push(
        `── era ${(variant.era ?? 0) + 1} starts above: ${reasons.join('; ') || 'setup changed'}`
      );
    }
  }
  const cells = table.filter((row): row is string[] => Array.isArray(row));
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column]!.length))
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd();
  return [
    line(header),
    ...table.map((row) => (Array.isArray(row) ? line(row) : `  ${row}`)),
  ];
}

/** The eval's history as `mst history` prints it. */
export function formatHistory(
  index: HistoryIndex,
  options: { where: string; limit: number }
): string {
  const names: string[] = [];
  for (const run of [...index.runs].reverse())
    for (const variant of run.variants)
      if (!names.includes(variant.name)) names.push(variant.name);
  const baseline = index.runs.find((run) => !run.partial)?.baseline;
  const out = [
    `History of ${index.evalName}: ${index.runs.length} ${index.runs.length === 1 ? 'run' : 'runs'}, newest first (${options.where})`,
  ];
  for (const name of names) {
    out.push('', `${name}${name === baseline ? ' (baseline)' : ''}`);
    out.push(
      ...variantTable(index, name, options.limit).map((row) => `  ${row}`)
    );
  }
  if (index.skipped.length)
    out.push(
      '',
      `Left out: ${index.skipped.map((run) => `${run.runId} (${run.reason})`).join('; ')}`
    );
  out.push(
    '',
    'Cases and Trials are pass rates; Since previous is the paired test on the headline cases against the previous run of the same era that was complete for the variant. Cost and tokens are per trial.'
  );
  return out.join('\n');
}

/** `mst history [eval dir]`. */
export async function history(
  evalDirectory: string | undefined,
  options: HistoryOptions
): Promise<void> {
  const { location, evalName, where } = await locate(evalDirectory, options);
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(
      `--limit must be a whole number above 0, not ${options.limit}.`
    );
  // The runs are the truth: a history.json that misses a run (a run that
  // finished while another wrote it) is brought up to date as it's read.
  const index = options.rebuild
    ? await updateHistory(location, { rebuild: true, evalName })
    : await buildHistory(location, { evalName });
  if (!index.runs.length && !index.skipped.length) {
    console.log(`No runs of ${evalName} in ${where}.`);
    return;
  }
  const shown = filtered(index, options);
  if (options.json) {
    console.log(
      JSON.stringify({ ...shown, runs: shown.runs.slice(0, limit) }, null, 2)
    );
    return;
  }
  console.log(formatHistory(shown, { where, limit }));
  if (options.rebuild) console.log(`\nRebuilt the history.json of ${where}.`);
}
