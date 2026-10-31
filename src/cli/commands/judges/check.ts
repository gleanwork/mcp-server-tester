/**
 * `mst judges check`: measures a judge against people's labels (ADR 0009).
 *
 *   mst judges check <run...> --judge <name> [--split test|dev|all]
 *     [--min-labels <n>] [--min-rate <rate>] [--max-unknown <rate>]
 *     [--no-record] [--json] [-d <dir>]
 */

import { readLabels } from '../../../evals/labels.js';
import { judgedItems } from '../../../evals/judgedItems.js';
import {
  calibrationRecord,
  checkJudge,
  evalDirectoryOf,
  writeCalibration,
  type JudgeCheck,
  type Rate,
  type UsableGate,
} from '../../../evals/judgeCheck.js';
import { existsSync } from 'node:fs';
import { readRunDirectory } from '../../../evals/runFormat.js';
import { runReportPath, writeRunReport } from '../../../evals/runReport.js';
import { resolveRunArgument } from '../../runArgument.js';

export interface JudgeCheckCommandOptions {
  judge: string;
  split?: string;
  minLabels?: string;
  minRate?: string;
  maxUnknown?: string;
  /** `--no-record` sets it to false. */
  record?: boolean;
  json?: boolean;
  dir?: string;
}

function number(
  value: string | undefined,
  flag: string,
  range: { min: number; max?: number; integer?: boolean }
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < range.min ||
    (range.max !== undefined && parsed > range.max) ||
    (range.integer && !Number.isInteger(parsed))
  )
    throw new Error(
      `${flag} ${value} isn't ${range.integer ? 'a whole number' : 'a number'} from ${range.min}${range.max !== undefined ? ` to ${range.max}` : ' up'}.`
    );
  return parsed;
}

function percent(rate: Rate): string {
  if (rate.value === null) return 'n/a (no labels)';
  return `${rate.value.toFixed(2)} (${rate.low!.toFixed(2)} to ${rate.high!.toFixed(2)})`;
}

/** `mst judges check`: one block per judge identity, newest first. */
export async function checkJudgeCommand(
  runArguments: string[],
  options: JudgeCheckCommandOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<JudgeCheck[]> {
  const split = options.split ?? 'test';
  if (split !== 'test' && split !== 'dev' && split !== 'all')
    throw new Error(`--split ${split} isn't test, dev or all.`);
  const minLabels = number(options.minLabels, '--min-labels', {
    min: 1,
    integer: true,
  });
  const minRate = number(options.minRate, '--min-rate', { min: 0, max: 1 });
  const maxUnknown = number(options.maxUnknown, '--max-unknown', {
    min: 0,
    max: 1,
  });
  const gate: Partial<UsableGate> = {
    ...(minLabels !== undefined
      ? { minPassLabels: minLabels, minFailLabels: minLabels }
      : {}),
    ...(minRate !== undefined ? { minRate } : {}),
    ...(maxUnknown !== undefined ? { maxUnknownRate: maxUnknown } : {}),
  };
  const directories = await Promise.all(
    runArguments.map((run) => resolveRunArgument(run, options.dir))
  );
  const runs = await Promise.all(
    directories.map(async (directory) => {
      const stored = await readRunDirectory(directory);
      return {
        stored,
        items: judgedItems(stored),
        labels: await readLabels(directory),
      };
    })
  );
  const checks = checkJudge(runs, { judge: options.judge, split, gate });
  if (checks.length === 0) {
    const labeled = runs.reduce(
      (sum, run) =>
        sum +
        run.labels.filter((label) => label.judge === options.judge).length,
      0
    );
    throw new Error(
      labeled === 0
        ? `No labels for "${options.judge}" in ${runArguments.join(', ')}. Label its verdicts with mst label export and mst label import.`
        : `None of the ${labeled} labels for "${options.judge}" is in the ${split} split with a verdict in these runs. Try --split all, or label more cases.`
    );
  }
  const written: string[][] = [];
  for (const check of checks) {
    const files: string[] = [];
    // Only labels set aside to measure a judge calibrate it.
    if (
      options.record !== false &&
      split === 'test' &&
      check.judgeIdentity !== undefined
    ) {
      const record = calibrationRecord({
        ...check,
        judgeIdentity: check.judgeIdentity,
      });
      const evals = new Set(
        directories
          .filter((_, i) => check.runs.includes(runs[i]!.stored.run.runId))
          .map((directory) => evalDirectoryOf(directory))
      );
      for (const evalDirectory of evals)
        files.push(await writeCalibration(evalDirectory, record));
    }
    written.push(files);
  }
  // A report shows its judges' calibrations, so rebuild the ones that exist.
  if (written.some((files) => files.length))
    for (const directory of directories)
      if (existsSync(runReportPath(directory))) await writeRunReport(directory);
  if (options.json) {
    print(
      `${JSON.stringify(
        checks.map((check, i) => ({ ...check, recorded: written[i] })),
        null,
        2
      )}\n`
    );
    return checks;
  }
  print(
    `${checks.map((check, i) => describeCheck(check, written[i]!, split)).join('\n\n')}\n`
  );
  return checks;
}

function describeCheck(
  check: JudgeCheck,
  files: string[],
  split: string
): string {
  const identity = check.judgeIdentity
    ? `identity ${check.judgeIdentity.slice(0, 12)}`
    : 'no identity (graded before MST recorded them)';
  const lines = [
    `${check.judge}  (${identity}${check.judgeModels.length ? `, ${check.judgeModels.join(', ')}` : ''})`,
    `  ${check.labels} ${split === 'all' ? '' : `${split} `}label${check.labels === 1 ? '' : 's'} from ${check.runs.length} run${check.runs.length === 1 ? '' : 's'}${check.unmatched ? `; ${check.unmatched} label${check.unmatched === 1 ? ' has' : 's have'} no verdict here` : ''}`,
  ];
  if (check.kind === 'pointwise') {
    const { counts } = check;
    lines.push(
      `  people   ${check.humanFail} fail, ${check.humanPass} pass`,
      `  TPR      ${percent(check.tpr)}  the judge failed ${counts.truePositive} of the ${counts.truePositive + counts.falseNegative} trials people failed`,
      `  TNR      ${percent(check.tnr)}  the judge passed ${counts.trueNegative} of the ${counts.trueNegative + counts.falsePositive} trials people passed`,
      `  kappa    ${check.kappa === null ? 'n/a' : check.kappa.toFixed(2)}`,
      `  unknown  ${check.unknown.k} of ${check.unknown.n}${check.unknown.value !== null ? ` (${(check.unknown.value * 100).toFixed(0)}%)` : ''}`,
      check.usable
        ? `  usable   yes`
        : `  usable   no: ${check.reasons.join('; ')}`
    );
  } else {
    lines.push(
      `  agreement  ${percent(check.agreement)}`,
      `  ties       judge ${percent(check.judgeTies)}; people ${percent(check.humanTies)}`,
      `  unknown    ${check.unknown.k} of ${check.unknown.n}`
    );
  }
  if (check.unversioned)
    lines.push(
      `  unversioned: the judge declares no version and its plugin has none, so a report can't tell when this calibration goes stale. Set the judge's version.`
    );
  if (files.length) lines.push(...files.map((file) => `  recorded ${file}`));
  else if (split !== 'test')
    lines.push(`  not recorded: only the test split calibrates a judge`);
  else if (!check.judgeIdentity)
    lines.push(
      `  not recorded: its verdicts have no judge identity; grade the run again (mst grade)`
    );
  if (check.disagreements.length) {
    lines.push(`  disagreements (${check.disagreements.length}):`);
    for (const item of check.disagreements.slice(0, 20))
      lines.push(
        `    ${item.runId.slice(-6)} ${item.variant} ${item.caseId}${item.trial !== undefined ? ` #${item.trial}` : ` vs ${item.baseline}`}: judge ${item.verdict}, label ${item.label}${item.reasoning ? `: ${item.reasoning.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`
      );
    if (check.disagreements.length > 20)
      lines.push(
        `    ...and ${check.disagreements.length - 20} more (--json lists them all)`
      );
  }
  return lines.join('\n');
}
