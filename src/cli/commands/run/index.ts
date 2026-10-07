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
  variant?: string;
  /** `--case`: run only these case ids. */
  case?: string[];
  /** `--trials`: trials per case. */
  trials?: string | number;
  outputDir?: string;
  secretsFile?: string;
  /** Credential store directory for connector servers. */
  store?: string;
}

function parseTrials(value: string | number): number {
  const trials = Number(value);
  if (!Number.isInteger(trials) || trials < 1)
    throw new Error(`--trials must be a positive integer, got "${value}"`);
  return trials;
}

export async function run(options: RunOptions): Promise<void> {
  const evalOptions: RunEvalOptions = {
    configPath: options.config,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    secretsFile: options.secretsFile,
    dryRun: options.dryRun,
    variant: options.variant,
    ...(options.case?.length ? { cases: options.case } : {}),
    ...(options.trials !== undefined
      ? { trials: parseTrials(options.trials) }
      : {}),
    ...(options.store
      ? { credentialStore: localCredentialStore(path.resolve(options.store)) }
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
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const metrics = result.summary.metrics as {
    passed?: number;
    failed?: number;
    total?: number;
    passRate?: number;
  };
  console.log(`\nEval complete: ${result.evalConfig.name}`);
  console.log(
    `Results: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed (${((metrics.passRate ?? 0) * 100).toFixed(1)}%)`
  );
  printVariantTable(result.summary.variants);
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
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
  if ((metrics.failed ?? 0) > 0) process.exitCode = 1;
}

type VariantSummary = Awaited<
  ReturnType<typeof runEval>
>['summary']['variants'][number];

/** One row per variant: outcomes, calls, tokens, cost and time ("-" when unavailable). */
function printVariantTable(variants: VariantSummary[]): void {
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
      `${variant.result?.passed ?? 0}/${variant.result?.total ?? 0}`,
      pct(value(variant, 'trial_pass_rate')),
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
    'Passed',
    'Trial pass',
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
