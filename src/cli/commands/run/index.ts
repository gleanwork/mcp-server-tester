import path from 'node:path';
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
} from '../../../evals/runEvalSuite.js';

export interface RunOptions {
  manifest: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
  arm?: string;
  outputDir?: string;
  secretsFile?: string;
}

export async function run(options: RunOptions): Promise<void> {
  const suiteOptions: RunEvalSuiteOptions = {
    manifestPath: options.manifest,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    secretsFile: options.secretsFile,
    dryRun: options.dryRun,
    arm: options.arm,
  };
  const result = await runEvalSuite(suiteOptions);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: result.manifest.name,
          outputDir: result.outputDir,
          datasets: result.datasets.map((item) => item.source),
          arms: result.manifest.arms?.map((arm) => arm.name) ?? ['default'],
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
  console.log(`\nEval complete: ${result.manifest.name}`);
  console.log(
    `Results: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed (${((metrics.passRate ?? 0) * 100).toFixed(1)}%)`
  );
  printArmTable(result.summary.arms);
  const previous = result.summary.previousRun;
  if (previous) {
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    console.log(
      `Previous run ${previous.runId} (${previous.timestamp}): pass rate ${pct(previous.passRate)} -> ${pct(metrics.passRate ?? 0)}` +
        (previous.sameManifest ? '' : ' (the manifest changed since)')
    );
    const list = (label: string, items: string[]) =>
      items.length === 0
        ? ''
        : `${items.length} ${label} (${items.slice(0, 5).join(', ')}${items.length > 5 ? `, +${items.length - 5} more` : ''})`;
    for (const [arm, change] of Object.entries(previous.arms)) {
      const parts = [
        list('regressed', change.regressed),
        list('improved', change.improved),
        list('added', change.added),
        list('removed', change.removed),
      ].filter(Boolean);
      if (parts.length) console.log(`  ${arm}: ${parts.join('; ')}`);
    }
  }
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
  if ((metrics.failed ?? 0) > 0) process.exitCode = 1;
}

type ArmSummary = Awaited<
  ReturnType<typeof runEvalSuite>
>['summary']['arms'][number];

/** One row per arm: outcomes, calls, tokens, cost and time ("-" when unavailable). */
function printArmTable(arms: ArmSummary[]): void {
  if (arms.length === 0) return;
  const value = (arm: ArmSummary, key: string) => {
    const v = arm.metrics?.[key];
    return typeof v === 'number' ? v : undefined;
  };
  const num = (v: number | undefined, digits = 1) =>
    v === undefined ? '-' : v.toFixed(digits);
  const pct = (v: number | undefined) =>
    v === undefined ? '-' : `${(v * 100).toFixed(0)}%`;
  const judged = arms.some(
    (arm) => value(arm, 'judge_pass_rate') !== undefined
  );
  let estimated = false;
  const rows = arms.map((arm) => {
    const cost = value(arm, 'cost_usd_mean');
    if (cost !== undefined && arm.costSource !== 'host') estimated = true;
    const mcp = value(arm, 'mcp_call_count_mean');
    const host = value(arm, 'host_event_count_mean');
    return [
      arm.name,
      `${arm.result?.passed ?? 0}/${arm.result?.total ?? 0}`,
      pct(value(arm, 'trial_pass_rate')),
      ...(judged ? [pct(value(arm, 'judge_pass_rate'))] : []),
      mcp === undefined && host === undefined
        ? '-'
        : `${num(mcp)} / ${num(host)}`,
      num(value(arm, 'input_tokens_mean'), 0),
      num(value(arm, 'output_tokens_mean'), 0),
      cost === undefined
        ? '-'
        : `$${cost.toFixed(4)}${arm.costSource === 'host' ? '' : '*'}`,
      value(arm, 'duration_s_mean') === undefined
        ? '-'
        : `${num(value(arm, 'duration_s_mean'))}s`,
    ];
  });
  const header = [
    'Arm',
    'Passed',
    'Trial pass',
    ...(judged ? ['Judge pass'] : []),
    'MCP calls / host events',
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
