/**
 * `mst label`: a person's labels for a run's judge verdicts (ADR 0009).
 *
 *   mst label <run> --judge <name> [--split test|dev] [--labeler <name>] [--port <n>] [--no-open]
 *   mst label import <run> <file> [--format csv|jsonl|judgekeeper] [--labeler <name>]
 *   mst label export <run> [--judge <name>...] [--format csv|jsonl|judgekeeper] [-o <file>]
 */

import fs from 'node:fs/promises';
import {
  LABEL_FORMATS,
  checkImportedLabels,
  formatLabels,
  formatOfFile,
  looksLikeJudgekeeper,
  parseLabels,
  readLabels,
  writeLabels,
  type LabelFormat,
} from '../../../evals/labels.js';
import { judgedItems, labelKey } from '../../../evals/judgedItems.js';
import {
  startLabelPage,
  type LabelPageServer,
} from '../../../evals/labelPage.js';
import { LABEL_SPLITS } from '../../../evals/runFormat.js';
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

export interface LabelPageCommandOptions {
  judge?: string;
  split?: string;
  labeler?: string;
  port?: string;
  /** Commander's `--no-open`. */
  open?: boolean;
  dir?: string;
}

/**
 * `mst label <run> --judge <name>`: serves the label page and opens it.
 * Returns the server; the CLI keeps it up until Ctrl+C.
 */
export async function labelPage(
  run: string,
  options: LabelPageCommandOptions,
  print: (text: string) => void = (text) => process.stdout.write(text),
  openPage: (url: string) => Promise<unknown> = async (url) => {
    const { default: openBrowser } = await import('open');
    return openBrowser(url);
  }
): Promise<LabelPageServer> {
  const split = options.split;
  if (
    split !== undefined &&
    !LABEL_SPLITS.includes(split as (typeof LABEL_SPLITS)[number])
  )
    throw new Error(`--split ${split} isn't ${LABEL_SPLITS.join(' or ')}.`);
  const port = options.port === undefined ? undefined : Number(options.port);
  if (
    port !== undefined &&
    !(Number.isInteger(port) && port >= 0 && port < 65536)
  )
    throw new Error(`--port ${options.port} isn't a port number.`);
  // The run first: a mistyped command (mst label exprot) is taken as a run.
  const directory = await resolveRunArgument(run, options.dir);
  if (options.judge === undefined)
    throw new Error(
      'Give --judge <name>: the judge whose verdicts to label, by its name in results.'
    );
  const server = await startLabelPage({
    directory,
    judge: options.judge,
    ...(split !== undefined
      ? { split: split as (typeof LABEL_SPLITS)[number] }
      : {}),
    ...(options.labeler !== undefined ? { labeler: options.labeler } : {}),
    ...(port !== undefined ? { port } : {}),
  });
  const labeled = server.data.items.filter(
    (item) => item.label !== undefined
  ).length;
  print(
    `Labeling ${options.judge} in ${directory}: ${server.data.items.length} verdict${server.data.items.length === 1 ? '' : 's'}, ${labeled} labeled.\n${server.url}\nPress Ctrl+C when you're done.\n`
  );
  if (options.open !== false)
    await openPage(server.url).catch(() => {
      print('Could not open a browser; open the address above.\n');
    });
  return server;
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
