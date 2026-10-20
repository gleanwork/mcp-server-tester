import { existsSync } from 'node:fs';
import { datasetContentHash } from '../../../evals/runFormat.js';
import { runReportPath } from '../../../evals/runReport.js';
import {
  headlinePassRate,
  headlineTallies,
} from '../../../evals/variantComparison.js';
import { suggestedTrialsPerCase } from '../../../evals/passRateInterval.js';
import path from 'node:path';
import { z } from 'zod';
import { describeError } from '../../../utils/describeError.js';
import {
  resumeRun,
  runEval,
  type RunEvalOptions,
} from '../../../evals/runEval.js';

export interface RunOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
  /** `--no-report`: don't write the run's report. */
  report?: boolean;
  /** `--variant`: run only these variants. */
  variant?: string[];
  /** `--case`: run only these case ids. */
  case?: string[];
  /** `--filter-tag`: run the cases with any of these tags. */
  filterTag?: string[];
  /** `--max-cases`: cases per dataset. */
  maxCases?: string | number;
  /** `--trials`: trials per case. */
  trials?: string | number;
  outputDir?: string;
  secretsFile?: string;
  /** Credential store for connector servers: a directory or a plugin's. */
  store?: string;
  /** `--env`: where to collect trials. */
  env?: string;
  /** `--env-option key=value`, each time it was given. */
  envOption?: string[];
  /** `--no-grade`: collect the trials without grading them. */
  grade?: boolean;
  /** `--resume <run>`: collect a run's missing trials and grade it again. */
  resume?: string;
  /** `--results <store>`: the result store that keeps the run. */
  results?: string;
}

/** Flags that would change what a resumed run is. */
const NOT_WITH_RESUME = [
  ['variant', '--variant'],
  ['case', '--case'],
  ['filterTag', '--filter-tag'],
  ['maxCases', '--max-cases'],
  ['trials', '--trials'],
  ['dryRun', '--dry-run'],
] as const;

/** `--env-option key=value` flags as an object; a key may be given once. */
export function parseEnvOptions(
  flags: readonly string[]
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const flag of flags) {
    const separator = flag.indexOf('=');
    if (separator < 1)
      throw new Error(`--env-option takes key=value, got "${flag}"`);
    const key = flag.slice(0, separator);
    if (Object.hasOwn(options, key))
      throw new Error(`--env-option ${key} is given twice`);
    options[key] = flag.slice(separator + 1);
  }
  return options;
}

function positiveInteger(flag: string, value: string | number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  return number;
}

/** `--case e2e-0011, --trials 1`: the flags that narrowed a run. */
function describeSelection(
  selection: NonNullable<
    Awaited<ReturnType<typeof runEval>>['summary']['selection']
  >
): string {
  return [
    selection.variants && `--variant ${selection.variants.join(' ')}`,
    selection.cases && `--case ${selection.cases.join(' ')}`,
    selection.filterTags && `--filter-tag ${selection.filterTags.join(' ')}`,
    selection.maxCases !== undefined && `--max-cases ${selection.maxCases}`,
    selection.trials !== undefined && `--trials ${selection.trials}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export async function run(options: RunOptions): Promise<void> {
  const evalOptions: RunEvalOptions = {
    configPath: options.config,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    secretsFile: options.secretsFile,
    dryRun: options.dryRun,
    ...(options.report === false ? { report: false } : {}),
    ...(options.grade === false ? { grade: false } : {}),
    ...(options.variant?.length ? { variant: options.variant } : {}),
    ...(options.case?.length ? { cases: options.case } : {}),
    ...(options.filterTag?.length ? { filterTags: options.filterTag } : {}),
    ...(options.maxCases !== undefined
      ? { maxCases: positiveInteger('--max-cases', options.maxCases) }
      : {}),
    ...(options.trials !== undefined
      ? { trials: positiveInteger('--trials', options.trials) }
      : {}),
    ...(options.store ? { store: options.store } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.envOption?.length
      ? { envOptions: parseEnvOptions(options.envOption) }
      : {}),
    ...(options.results ? { results: options.results } : {}),
  };
  if (options.resume !== undefined) {
    const given: string[] = NOT_WITH_RESUME.filter(([key]) => {
      const value = options[key];
      return Array.isArray(value) ? value.length > 0 : value !== undefined;
    }).map(([, flag]) => flag);
    if (options.grade === false) given.push('--no-grade');
    if (given.length)
      throw new Error(
        `--resume completes a run as it was started, so it can't take ${given.join(', ')}.`
      );
  }
  let result: Awaited<ReturnType<typeof runEval>>;
  try {
    result =
      options.resume === undefined
        ? await runEval(evalOptions)
        : await resumeRun({
            configPath: evalOptions.configPath,
            run: options.resume,
            ...(evalOptions.rootDir ? { rootDir: evalOptions.rootDir } : {}),
            ...(evalOptions.pluginPaths
              ? { pluginPaths: evalOptions.pluginPaths }
              : {}),
            ...(evalOptions.outputDir
              ? { outputDir: evalOptions.outputDir }
              : {}),
            ...(evalOptions.secretsFile
              ? { secretsFile: evalOptions.secretsFile }
              : {}),
            ...(evalOptions.report === false ? { report: false } : {}),
            ...(evalOptions.env ? { env: evalOptions.env } : {}),
            ...(evalOptions.envOptions
              ? { envOptions: evalOptions.envOptions }
              : {}),
            ...(evalOptions.store ? { store: evalOptions.store } : {}),
            ...(evalOptions.results ? { results: evalOptions.results } : {}),
          });
  } catch (error) {
    // A validation failure says which config it is in.
    if (error instanceof z.ZodError)
      throw new Error(`${options.config}: ${describeError(error)}`, {
        cause: error,
      });
    throw error;
  }

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: result.evalConfig.name,
          outputDir: result.outputDir,
          // Each dataset as declared, and what it loaded: cases, their
          // hash, and for a plugin's dataset which copy.
          datasets: result.datasets.map(({ source, dataset }) => ({
            ...source,
            ...(dataset
              ? {
                  name: dataset.name,
                  caseCount: dataset.cases.length,
                  contentHash: datasetContentHash(dataset),
                  ...dataset.origin,
                }
              : {}),
          })),
          variants: result.evalConfig.variants?.map(
            (variant) => variant.name
          ) ?? ['default'],
          partial: result.summary.partial ?? false,
          ...(result.summary.selection
            ? { selection: result.summary.selection }
            : {}),
          env: {
            name: result.environment.name,
            shards: result.environment.shards,
            ...(result.environment.keep !== 'never'
              ? { keep: result.environment.keep }
              : {}),
            ...(Object.keys(result.environment.options).length
              ? { options: result.environment.options }
              : {}),
          },
        },
        null,
        2
      )}\n`
    );
    return;
  }
  printRunResult(result, options.config);
}

/**
 * What a run (or a regrade) did: totals, the variant table, pairwise
 * preferences, the previous run and where the run is. Sets a failing exit
 * code when a graded case failed, or an ungraded run has a trial that failed
 * to collect.
 */
export function printRunResult(
  result: Awaited<ReturnType<typeof runEval>>,
  config: string
): void {
  const metrics = result.summary.metrics as {
    passed?: number;
    failed?: number;
    total?: number;
    passRate?: number;
    incomplete?: number;
  };
  const runId = path.basename(result.outputDir);
  const graded = result.summary.graded !== false;
  console.log(`\nEval complete: ${result.evalConfig.name}`);
  if (graded)
    console.log(
      `Results: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed (${((metrics.passRate ?? 0) * 100).toFixed(1)}%)`
    );
  else
    console.log(
      `Collected ${metrics.total ?? 0} cases, not graded. Grade them with \`mst grade ${runId.split('-').pop()} -c ${config}\`.`
    );
  // Grading can't rescue a trial the client never finished: say so now.
  const uncollected = graded
    ? []
    : result.summary.results.filter((caseResult) =>
        caseResult.trialResults?.length
          ? caseResult.trialResults.some((trial) => trial.error !== undefined)
          : caseResult.error !== undefined
      );
  if (uncollected.length) {
    const names = uncollected.map((caseResult) =>
      caseResult.variant
        ? `${caseResult.variant}/${caseResult.id}`
        : caseResult.id
    );
    console.log(
      `${uncollected.length} failed to collect (${names.slice(0, 5).join(', ')}${names.length > 5 ? `, +${names.length - 5} more` : ''}); grading fails them. See the report for each error.`
    );
  }
  printVariantTable(result.summary.variants, graded);
  printPairwise(result.summary.variants);
  const { selection } = result.summary;
  if (result.summary.partial && selection) {
    console.log(
      `Partial run (${describeSelection(selection)}): not compared with full runs`
    );
    const baseline =
      result.evalConfig.baseline ?? result.evalConfig.variants?.[0]?.name;
    if (
      selection.variants &&
      baseline &&
      !selection.variants.includes(baseline)
    )
      console.log(
        `The baseline "${baseline}" didn't run, so no variant is compared with it.`
      );
  }
  const previous = result.summary.previousRun;
  if (previous && !previous.sameConfig)
    console.log(
      `Previous run ${previous.runId}: the eval config changed since, so there is nothing to compare with.`
    );
  else if (previous) {
    const points = (value: number) =>
      `${value >= 0 ? '+' : '-'}${Math.abs(value * 100).toFixed(1)}`;
    console.log(`Previous run ${previous.runId} (${previous.timestamp}):`);
    // The same paired test as the report's variant comparisons.
    for (const [variant, change] of Object.entries(previous.variants)) {
      const test = change.change;
      if (!test) continue;
      const range = `95% range ${points(test.lower)} to ${points(test.upper)} pts`;
      // Every case scored as before: no change, not an unclear one.
      const same =
        test.upper - test.lower < 0.0005 && Math.abs(test.mean) < 0.0005;
      console.log(
        `  ${variant}: ${
          same
            ? 'no change: every case passed as many trials as before'
            : test.assessment === 'unclear'
              ? `no clear change (${points(test.mean)} pts, ${range})`
              : `clearly ${test.assessment} (${points(test.mean)} pts, ${range})`
        }`
      );
    }
    const list = (label: string, items: string[]) =>
      items.length === 0
        ? ''
        : `${items.length} ${label} (${items.slice(0, 5).join(', ')}${items.length > 5 ? `, +${items.length - 5} more` : ''})`;
    for (const [variant, change] of Object.entries(previous.variants)) {
      const parts = [
        list('regressed', change.regressed),
        list('improved', change.improved),
        list('added', change.added),
        list('removed', change.removed),
      ].filter(Boolean);
      if (parts.length) console.log(`  ${variant}: ${parts.join('; ')}`);
    }
  }
  console.log(`Output: ${result.outputDir}`);
  if (result.storedIn) console.log(`Stored in: ${result.storedIn}`);
  const report = runReportPath(result.outputDir);
  if (existsSync(report))
    // A partial or ungraded run never becomes the eval's latest, so name it.
    console.log(
      `Report: ${report} (open it with \`mst open${result.summary.partial || !graded ? ` ${result.outputDir}` : ''}\`)`
    );
  if (metrics.incomplete)
    console.log(
      `${metrics.incomplete} cases are incomplete: their shard ended before every trial came back.`
    );
  // A run that didn't finish isn't a success either.
  if (
    (graded && (metrics.failed ?? 0) > 0) ||
    uncollected.length ||
    (metrics.incomplete ?? 0) > 0
  )
    process.exitCode = 1;
}

type VariantSummary = Awaited<
  ReturnType<typeof runEval>
>['summary']['variants'][number];

/** One row per variant: outcomes, calls, tokens, cost and time ("-" when unavailable). */
function printVariantTable(variants: VariantSummary[], graded = true): void {
  if (variants.length === 0) return;
  const value = (variant: VariantSummary, key: string) => {
    const v = variant.metrics?.[key];
    return typeof v === 'number' ? v : undefined;
  };
  const num = (v: number | undefined, digits = 1) =>
    v === undefined ? '-' : v.toFixed(digits);
  const pct = (v: number | undefined) =>
    v === undefined ? '-' : `${(v * 100).toFixed(0)}%`;
  const judged = variants.some(
    (variant) => value(variant, 'judge_pass_rate') !== undefined
  );
  // The report's headline rate and its 95% range, so the two agree.
  const headlines = variants.map((variant) =>
    variant.result ? headlinePassRate(variant.result) : undefined
  );
  let estimated = false;
  const rows = variants.map((variant, index) => {
    const headline = headlines[index];
    const interval = headline?.interval;
    const cost = value(variant, 'cost_usd_mean');
    if (cost !== undefined && variant.costSource !== 'client') estimated = true;
    const mcp = value(variant, 'mcp_call_count_mean');
    const client = value(variant, 'builtin_event_count_mean');
    return [
      variant.name,
      // An ungraded run's trials pass unless they errored: not results.
      ...(graded
        ? [
            `${variant.result?.passed ?? 0}/${variant.result?.total ?? 0}`,
            pct(headline?.passRate),
            interval
              ? `${rangeText(interval)}${interval.tooWide ? ' !' : ''}`
              : '-',
          ]
        : []),
      ...(judged ? [pct(value(variant, 'judge_pass_rate'))] : []),
      mcp === undefined && client === undefined
        ? '-'
        : `${num(mcp)} / ${num(client)}`,
      num(value(variant, 'input_tokens_mean'), 0),
      num(value(variant, 'output_tokens_mean'), 0),
      cost === undefined
        ? '-'
        : `$${cost.toFixed(4)}${variant.costSource === 'client' ? '' : '*'}`,
      value(variant, 'duration_s_mean') === undefined
        ? '-'
        : `${num(value(variant, 'duration_s_mean'))}s`,
    ];
  });
  const header = [
    'Variant',
    ...(graded ? ['Passed', 'Pass rate', 'Likely range'] : []),
    ...(judged ? ['Judge pass'] : []),
    'MCP calls / client events',
    'Input tokens',
    'Output tokens',
    'Cost',
    'Time',
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length))
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd();
  console.log('');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  console.log(
    'Pass rate is the mean over cases of the share of trials that passed. Likely range is where the true pass rate likely lies (95% confidence), counting cases, not trials, as the sample.'
  );
  console.log(
    'Calls, tokens, cost and time are means per trial.' +
      (estimated ? ' * Includes estimates from `pricing`.' : '')
  );
  if (graded) printTooFewTrials(variants, headlines);
}

/**
 * The report's "too few trials" note: which variant's range is too wide
 * (marked `!` in the table), and the trials per case to run next.
 */
function printTooFewTrials(
  variants: VariantSummary[],
  headlines: Array<ReturnType<typeof headlinePassRate> | undefined>
): void {
  let widest:
    | { name: string; passRate: number; lower: number; upper: number }
    | undefined;
  for (const [index, variant] of variants.entries()) {
    const headline = headlines[index];
    const interval = headline?.interval;
    if (
      interval?.tooWide &&
      (!widest || interval.upper - interval.lower > widest.upper - widest.lower)
    )
      widest = {
        name: variant.name,
        passRate: headline?.passRate ?? 0,
        ...interval,
      };
  }
  if (!widest) return;
  const counts = variants.flatMap((variant) =>
    (variant.result?.caseResults ?? []).map(
      (result) => result.trialResults?.length || 1
    )
  );
  const perCase = counts.length ? Math.min(...counts) : 0;
  const caseCount = Math.max(
    0,
    ...variants.map((variant) => variant.result?.caseResults.length ?? 0)
  );
  // The most any too-wide variant needs, as the report suggests it.
  let next: number | undefined;
  for (const [index, variant] of variants.entries()) {
    if (!headlines[index]?.interval?.tooWide || !variant.result) continue;
    const needed = suggestedTrialsPerCase(
      headlineTallies(variant.result),
      perCase
    );
    if (needed === undefined) {
      next = undefined;
      break;
    }
    next = Math.max(next ?? 0, needed);
  }
  const trials = `${perCase} ${perCase === 1 ? 'trial' : 'trials'} per case`;
  const [lower, upper] = rangeEnds(widest);
  console.log(
    '! Too few trials to tell: ' +
      // Every trial passed: the low end is the weakest rate it can't rule out.
      (widest.passRate === 1
        ? `${widest.name} passed every trial, but ${trials} can't tell a server that always passes from one that passes ${lower} of the time.`
        : `with ${trials}, ${widest.name}'s true pass rate is likely anywhere from ${lower} to ${upper}.`) +
      (next !== undefined
        ? ` Set "run": { "trials": ${next} } in the eval config and run it again.`
        : ` More trials per case won't narrow it enough with ${caseCount} ${caseCount === 1 ? 'case' : 'cases'}: add cases.`)
  );
}

/** A 95% range's ends in whole percents, rounded outward so it never looks narrower: ["39%", "100%"]. */
function rangeEnds(interval: {
  lower: number;
  upper: number;
}): [string, string] {
  // A hair of slack, so 0.4 (40.000...04%) isn't floored to 39%.
  const lower = Math.floor(interval.lower * 100 + 1e-9);
  const upper = Math.ceil(interval.upper * 100 - 1e-9);
  return [`${lower}%`, `${upper}%`];
}

/** A 95% range in whole percents: "39%-100%". */
function rangeText(interval: { lower: number; upper: number }): string {
  return rangeEnds(interval).join('-');
}

/** Each pairwise judge's verdict on each variant against the baseline. */
function printPairwise(variants: VariantSummary[]): void {
  const pct = (part: number, whole: number) =>
    whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;
  for (const variant of variants) {
    for (const judge of variant.pairwise?.summary ?? []) {
      const n = judge.compared;
      console.log(
        `Pairwise ${judge.judge}: ${variant.name} vs ${variant.pairwise!.baseline}: ` +
          `${pct(judge.candidateWins, n)} win · ${pct(judge.baselineWins, n)} loss · ${pct(judge.ties, n)} tie (${n} cases` +
          `${judge.errors ? `, ${judge.errors} errors` : ''})`
      );
    }
  }
}
