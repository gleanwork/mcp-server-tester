/**
 * `mst label`: a person's labels for a run's judge verdicts (ADR 0009).
 *
 *   mst label import <run> <file> [--format csv|jsonl|judgekeeper] [--labeler <name>]
 *   mst label export <run> [--judge <name>...] [--format csv|jsonl|judgekeeper] [-o <file>]
 */

import fs from 'node:fs/promises';
import {
  LABEL_FORMATS,
  checkImportedLabels,
  formatLabels,
  formatOfFile,
  judgedItems,
  labelKey,
  looksLikeJudgekeeper,
  parseLabels,
  readLabels,
  writeLabels,
  type LabelFormat,
} from '../../../evals/labels.js';
import { labelQuestion, readRunDirectory } from '../../../evals/runFormat.js';
import { resolveRunArgument } from '../../runArgument.js';

export interface LabelImportCommandOptions {
  format?: string;
  labeler?: string;
  /** Where runs are written, to find a run by ID. */
  dir?: string;
}

export interface LabelExportCommandOptions {
  format?: string;
  judge?: string[];
  output?: string;
  dir?: string;
}

function labelFormat(value: string | undefined): LabelFormat | undefined {
  if (value === undefined) return undefined;
  if (!LABEL_FORMATS.includes(value as LabelFormat))
    throw new Error(
      `--format ${value} isn't one of ${LABEL_FORMATS.join(', ')}.`
    );
  return value as LabelFormat;
}

/** `mst label import`: adds a file's labels to a run, replacing labels for the same verdicts. */
export async function labelImport(
  run: string,
  file: string,
  options: LabelImportCommandOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const directory = await resolveRunArgument(run, options.dir);
  const text = await fs.readFile(file, 'utf8');
  const format =
    labelFormat(options.format) ??
    (formatOfFile(file) === 'csv'
      ? 'csv'
      : looksLikeJudgekeeper(text)
        ? 'judgekeeper'
        : formatOfFile(file));
  if (format === undefined)
    throw new Error(
      `Can't tell ${file}'s format from its name: give --format ${LABEL_FORMATS.join('|')}.`
    );
  const stored = await readRunDirectory(directory);
  const existing = await readLabels(directory);
  const labels = checkImportedLabels(
    parseLabels(format, text, file),
    judgedItems(stored),
    existing,
    options.labeler !== undefined ? { labeler: options.labeler } : {}
  );
  await writeLabels(directory, labels);
  const before = new Set(existing.map((label) => labelKey(label)));
  const replaced = labels.filter((label) => before.has(labelKey(label))).length;
  const tests = labels.filter((label) => label.split === 'test').length;
  print(
    `Imported ${labels.length} label${labels.length === 1 ? '' : 's'} into ${directory} (${tests} test, ${labels.length - tests} dev${replaced ? `; ${replaced} replaced earlier labels` : ''}).\n`
  );
}

/**
 * `mst label export`: a row for each judge verdict in a run, with its label
 * when it has one. Fill in the `label` column and import the file back.
 */
export async function labelExport(
  run: string,
  options: LabelExportCommandOptions,
  print: (text: string) => void = (text) => process.stdout.write(text),
  warn: (text: string) => void = (text) => process.stderr.write(text)
): Promise<void> {
  const directory = await resolveRunArgument(run, options.dir);
  const format =
    labelFormat(options.format) ??
    (options.output !== undefined ? formatOfFile(options.output) : undefined) ??
    'csv';
  const stored = await readRunDirectory(directory);
  const judges = options.judge?.length ? new Set(options.judge) : undefined;
  const wanted = (item: { judge: string; criterion?: string }) =>
    !judges || judges.has(item.judge) || judges.has(labelQuestion(item));
  const items = judgedItems(stored).filter(wanted);
  const labels = (await readLabels(directory)).filter(wanted);
  if (judges && items.length === 0 && labels.length === 0) {
    const names = [
      ...new Set(judgedItems(stored).map((item) => labelQuestion(item))),
    ].sort();
    throw new Error(
      `Run ${stored.run.runId} has no verdicts from ${[...judges].join(', ')}${names.length ? `; its judges are ${names.join(', ')}` : ''}.`
    );
  }
  if (stored.run.redactStoredResponses)
    warn(
      `[mst] Run ${stored.run.runId} redacts stored responses, so the export has no answers to read. To label from answers, collect with "redactStoredResponses": false in the eval config.\n`
    );
  const text = formatLabels(format, stored, items, labels);
  if (options.output !== undefined) {
    await fs.writeFile(options.output, text);
    warn(
      `Wrote ${items.length} verdict${items.length === 1 ? '' : 's'} and ${labels.length} label${labels.length === 1 ? '' : 's'} to ${options.output}.\n`
    );
  } else print(text);
}
