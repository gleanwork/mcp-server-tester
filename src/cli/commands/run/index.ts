import { existsSync } from 'node:fs';
import { runReportPath } from '../../../evals/runReport.js';
import path from 'node:path';
import { z } from 'zod';
import { localCredentialStore } from '../../../auth/grants/localStore.js';
import { describeError } from '../../../utils/describeError.js';
import { runEval, type RunEvalOptions } from '../../../evals/runEval.js';

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
  /** Credential store directory for connector servers. */
  store?: string;
  /** `--env`: where to collect trials. */
  env?: string;
  /** `--env-option key=value`, each time it was given. */
  envOption?: string[];
  /** `--no-grade`: collect the trials without grading them. */
  grade?: boolean;
}

/** `--env-option key=value` flags as an object; a key may be given once. */
function parseEnvOptions(flags: readonly string[]): Record<string, string> {
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
    ...(options.store
      ? { credentialStore: localCredentialStore(path.resolve(options.store)) }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.envOption?.length
      ? { envOptions: parseEnvOptions(options.envOption) }
      : {}),
  };
  let result: Awaited<ReturnType<typeof runEval>>;
  try {
    result = await runEval(evalOptions);
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
          datasets: result.datasets.map((item) => item.source),
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
  if (previous) {
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    console.log(
      `Previous run ${previous.runId} (${previous.timestamp}): pass rate ${pct(previous.passRate)} -> ${pct(metrics.passRate ?? 0)}` +
        (previous.sameConfig ? '' : ' (the eval config changed since)')
    );
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
  const report = runReportPath(result.outputDir);
  if (existsSync(report))
    // A partial or ungraded run never becomes the eval's latest, so name it.
    console.log(
      `Report: ${report} (open it with \`mst open${result.summary.partial || !graded ? ` ${result.outputDir}` : ''}\`)`
    );
  if ((graded && (metrics.failed ?? 0) > 0) || uncollected.length)
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
  let estimated = false;
  const rows = variants.map((variant) => {
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
            pct(value(variant, 'trial_pass_rate')),
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
    ...(graded ? ['Passed', 'Trial pass'] : []),
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
    'Calls, tokens, cost and time are means per trial.' +
      (estimated ? ' * Includes estimates from `pricing`.' : '')
  );
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
