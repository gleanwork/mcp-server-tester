/**
 * Labels (ADR 0009): what a person answered to a judge's question, kept in
 * the run directory beside the judge's verdicts so that `mst judges check`
 * can compare the two.
 *
 * A label belongs to the question, not to a judge version: the judge's name
 * in results (its rubric for a `rubric` judge, else its reference), plus a
 * criterion for a judge that checks several. A new prompt or judge model is
 * measured against the same labels.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../utils/jsonFile.js';
import { RUN_FORMAT } from './resultFormat.js';
import {
  LABEL_SPLITS,
  PAIRWISE_LABELS,
  type POINTWISE_LABELS,
  isInfraTrial,
  labelQuestion,
  labelRecordPath,
  parseLabelRecord,
  type LabelRecord,
  type StoredRun,
} from './runFormat.js';
import type { GraderScore } from '../types/index.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';

export type LabelSplit = (typeof LABEL_SPLITS)[number];
type PointwiseLabel = (typeof POINTWISE_LABELS)[number];
type PairwiseLabel = (typeof PAIRWISE_LABELS)[number];

/**
 * The split a case's labels go in when none is given. Half the cases, by a
 * hash of the case ID, measure the judge (`test`). Every trial and variant of
 * a case shares its split, so a case a person reads while changing the judge
 * never measures it.
 */
export function defaultSplit(caseId: string): LabelSplit {
  const first = createHash('sha256')
    .update(`mst-label-split\0${caseId}`)
    .digest()[0]!;
  return first < 128 ? 'test' : 'dev';
}

/** Every label a run stores, in file order. */
export async function readLabels(directory: string): Promise<LabelRecord[]> {
  const root = path.join(directory, 'labels');
  let files: string[];
  try {
    files = await fs.readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const labels: LabelRecord[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const full = path.join(root, file);
    labels.push(parseLabelRecord(await readJsonFile(full), full));
  }
  return labels;
}

/**
 * Writes labels into a run, replacing any label with the same key. Every
 * label's file is worked out before any is written.
 */
export async function writeLabels(
  directory: string,
  labels: readonly LabelRecord[]
): Promise<void> {
  const files = labels.map((label) =>
    path.join(directory, labelRecordPath(keyOf(label) as LabelPathFields))
  );
  for (const [i, label] of labels.entries())
    await writeJsonFile(files[i]!, label);
}

type LabelPathFields = Parameters<typeof labelRecordPath>[0];

/**
 * Copies a run's labels into a run made from it (a regrade or a resume), so
 * a judge graded again is measured against the same labels. Labels the new
 * run already has are kept.
 */
export async function carryLabels(from: string, to: string): Promise<void> {
  if (path.resolve(from) === path.resolve(to)) return;
  const source = path.join(from, 'labels');
  const exists = await fs.stat(source).then(
    (info) => info.isDirectory(),
    () => false
  );
  if (!exists) return;
  await fs.cp(source, path.join(to, 'labels'), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

/** What a judge said: `unknown` when it couldn't decide (it skipped). */
type JudgeVerdict = PointwiseLabel | PairwiseLabel | 'unknown';

/** One verdict a judge gave in a run: what a label is compared with. */
export interface JudgedItem {
  judge: string;
  criterion?: string;
  variant: string;
  caseId: string;
  /** Pointwise: the trial's index, as in `traces/<variant>/<case-id>/<trial>.json`. */
  trial?: number;
  /** Pairwise: the variant this one was compared with. */
  baseline?: string;
  /** Absent when the judge failed to run. */
  verdict?: JudgeVerdict;
  judgeIdentity?: string;
  /** The judge has no version MST can see change. */
  judgeUnversioned?: true;
  judgeProvider?: string;
  judgeModel?: string;
  reasoning?: string;
  /** The case's input. */
  input?: string;
  /** The trial's final answer, when the run stores responses. */
  answer?: string;
}

function caseTrials(
  result: EvalCaseResult
): Array<{ trial: number; result: EvalCaseResult | TrialResult }> {
  return result.trialResults?.length
    ? result.trialResults.map((trial, index) => ({
        trial: index,
        result: trial,
      }))
    : [{ trial: 0, result }];
}

function judgeResults(score: GraderScore | undefined): GraderScore[] {
  if (!score) return [];
  return score.judgeResults?.length ? score.judgeResults : [score];
}

function pointwiseVerdict(score: GraderScore): JudgeVerdict | undefined {
  if (score.error !== undefined) return undefined;
  if (score.skipped) return 'unknown';
  return score.pass ? 'pass' : 'fail';
}

/**
 * Every verdict a run's judges gave: each pointwise judge's for each trial,
 * and each pairwise judge's for each case. Trials that failed on
 * infrastructure have no verdicts.
 */
export function judgedItems(stored: StoredRun): JudgedItem[] {
  const items: JudgedItem[] = [];
  for (const variant of stored.summary.variants) {
    for (const caseResult of variant.result?.caseResults ?? []) {
      const input = caseResult.request?.input;
      for (const { trial, result } of caseTrials(caseResult)) {
        // A trial the client couldn't run has no verdicts. One a grader
        // failed on keeps the other judges' verdicts.
        if (isInfraTrial(result) && result.gradingError === undefined) continue;
        const answer =
          'trace' in result && result.trace?.finalText !== undefined
            ? result.trace.finalText
            : undefined;
        for (const score of judgeResults(result.scores?.judge)) {
          if (score.judgeName === undefined) continue;
          const verdict = pointwiseVerdict(score);
          items.push({
            judge: score.judgeName,
            variant: variant.name,
            caseId: caseResult.id,
            trial,
            ...(verdict !== undefined ? { verdict } : {}),
            ...optional('judgeIdentity', score.judgeIdentity),
            ...optional('judgeUnversioned', score.judgeUnversioned),
            ...optional('judgeProvider', score.judgeProvider),
            ...optional('judgeModel', score.judgeModel),
            ...optional('reasoning', score.reasoning),
            ...optional('input', input),
            ...optional('answer', answer),
          });
        }
      }
    }
    const pairwise = variant.pairwise;
    if (!pairwise) continue;
    for (const comparison of pairwise.cases) {
      const caseResult = variant.result?.caseResults?.find(
        (result) => result.id === comparison.id
      );
      for (const preference of comparison.preferences) {
        const verdict: JudgeVerdict | undefined =
          preference.error !== undefined
            ? undefined
            : preference.skipped
              ? 'unknown'
              : preference.preference;
        items.push({
          judge: preference.judge,
          variant: variant.name,
          baseline: pairwise.baseline,
          caseId: comparison.id,
          ...(verdict !== undefined ? { verdict } : {}),
          ...optional('judgeProvider', preference.provider),
          ...optional('judgeModel', preference.model),
          ...optional('reasoning', preference.reasoning),
          ...optional('input', caseResult?.request?.input),
        });
      }
    }
  }
  return items;
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** What a label and the verdict it labels have in common. */
type LabelKeyFields = Pick<
  JudgedItem,
  'judge' | 'criterion' | 'variant' | 'caseId' | 'trial' | 'baseline'
>;

function keyOf(label: LabelRecord): LabelKeyFields {
  return {
    judge: label.judge,
    ...optional('criterion', label.criterion),
    variant: label.variant,
    caseId: label.caseId,
    ...('trial' in label && typeof label.trial === 'number'
      ? { trial: label.trial }
      : {}),
    ...('baseline' in label && typeof label.baseline === 'string'
      ? { baseline: label.baseline }
      : {}),
  };
}

/** The key a label and the verdict it labels share. */
export function labelKey(item: LabelKeyFields | LabelRecord): string {
  const key = 'kind' in item ? keyOf(item) : item;
  return JSON.stringify([
    labelQuestion(key),
    key.variant,
    key.caseId,
    key.trial ?? null,
    key.baseline ?? null,
  ]);
}

/** The formats `mst label import` and `mst label export` read and write. */
export const LABEL_FORMATS = ['csv', 'jsonl', 'judgekeeper'] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

/** The columns of a CSV or JSONL export, in order. */
const COLUMNS = [
  'judge',
  'criterion',
  'variant',
  'baseline',
  'caseId',
  'trial',
  'split',
  'verdict',
  'label',
  'labeler',
  'labeledAt',
  'note',
  'input',
  'answer',
] as const;

type Row = Partial<Record<(typeof COLUMNS)[number], string | number>>;

/**
 * One row per verdict, with its label when it has one: a sheet a person can
 * fill in and import. A label whose verdict the run lacks gets its own row.
 */
function exportRows(
  items: readonly JudgedItem[],
  labels: readonly LabelRecord[]
): Array<{ item?: JudgedItem; label?: LabelRecord; row: Row }> {
  const byKey = new Map(labels.map((label) => [labelKey(label), label]));
  const rows: Array<{ item?: JudgedItem; label?: LabelRecord; row: Row }> =
    items.map((item) => {
      const label = byKey.get(labelKey(item));
      byKey.delete(labelKey(item));
      return { item, ...(label ? { label } : {}), row: rowOf(item, label) };
    });
  for (const label of byKey.values())
    rows.push({ label, row: rowOf(undefined, label) });
  return rows;
}

function rowOf(item: JudgedItem | undefined, label?: LabelRecord): Row {
  const key = item ?? keyOf(label!);
  const row: Row = {
    judge: key.judge,
    ...optional('criterion', key.criterion),
    variant: key.variant,
    ...optional('baseline', key.baseline),
    caseId: key.caseId,
    ...optional('trial', key.trial),
    split: label?.split ?? defaultSplit(key.caseId),
    ...optional('verdict', item?.verdict),
    ...optional('label', label?.label),
    ...optional('labeler', label?.labeler),
    ...optional('labeledAt', label?.labeledAt),
    ...optional('note', label?.note),
    ...optional('input', item?.input),
    ...optional('answer', item?.answer),
  };
  return row;
}

/** Writes a run's verdicts and labels in `format`. */
export function formatLabels(
  format: LabelFormat,
  stored: StoredRun,
  items: readonly JudgedItem[],
  labels: readonly LabelRecord[]
): string {
  const rows = exportRows(items, labels);
  if (format === 'csv')
    return (
      [
        COLUMNS.join(','),
        ...rows.map(({ row }) =>
          COLUMNS.map((column) => csvCell(row[column])).join(',')
        ),
      ].join('\r\n') + '\r\n'
    );
  if (format === 'jsonl')
    return rows.map(({ row }) => `${JSON.stringify(row)}\n`).join('');
  return rows
    .flatMap(({ item, label }) => judgekeeperRecords(stored, item, label))
    .map((record) => `${JSON.stringify(record)}\n`)
    .join('');
}

/** judgekeeper's `target_id` for a trial: reversible, so its labels import back. */
function targetId(
  variant: string,
  caseId: string,
  trial: number | undefined
): string {
  return [variant, caseId, String(trial ?? '')]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/**
 * judgekeeper's records (schema_version 2): the judge's verdict as an `LLM`
 * record and the label as a `HUMAN` one. judgekeeper checks pass or fail
 * judges, so pairwise verdicts are left out.
 */
function judgekeeperRecords(
  stored: StoredRun,
  item: JudgedItem | undefined,
  label: LabelRecord | undefined
): Array<Record<string, unknown>> {
  const key = item ?? keyOf(label!);
  if (key.trial === undefined) return [];
  const common = {
    schema_version: 2,
    target_id: targetId(key.variant, key.caseId, key.trial),
    name: labelQuestion(key),
  };
  const mst = {
    runId: stored.run.runId,
    variant: key.variant,
    caseId: key.caseId,
    trial: key.trial,
    ...optional('criterion', key.criterion),
  };
  const records: Array<Record<string, unknown>> = [];
  if (item?.verdict === 'pass' || item?.verdict === 'fail')
    records.push({
      ...common,
      annotator_kind: 'LLM',
      label: item.verdict,
      ...optional('explanation', item.reasoning),
      run: key.trial,
      ...optional('input', item.input),
      ...optional('output', item.answer),
      evaluator: {
        provider: item.judgeProvider ?? null,
        model: item.judgeModel ?? null,
        version: item.judgeIdentity ?? null,
      },
      created_at: stored.run.finishedAt,
      metadata: { mst },
    });
  if (label)
    records.push({
      ...common,
      annotator_kind: 'HUMAN',
      label: label.label,
      created_at: label.labeledAt,
      metadata: {
        mst: {
          ...mst,
          split: label.split,
          labeler: label.labeler,
          ...optional('note', label.note),
        },
      },
    });
  return records;
}

/** A label read from a file, before it is checked against the run. */
export interface ImportedLabel {
  judge: string;
  criterion?: string;
  variant: string;
  caseId: string;
  trial?: number;
  baseline?: string;
  label: string;
  split?: string;
  labeler?: string;
  labeledAt?: string;
  note?: string;
  /** Where it came from, for errors: `labels.csv:12`. */
  source: string;
}

/** Reads labels from a CSV, JSONL or judgekeeper file's text. Rows without a label are skipped. */
export function parseLabels(
  format: LabelFormat,
  text: string,
  file: string
): ImportedLabel[] {
  if (format === 'csv') {
    let table: string[][];
    try {
      table = parseCsv(text);
    } catch (error) {
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const [header, ...rows] = table;
    if (!header) return [];
    const columns = header.map((name) => name.trim());
    return rows.flatMap((cells, index) => {
      if (cells.every((cell) => cell.trim() === '')) return [];
      const row = Object.fromEntries(
        columns.map((column, i) => [column, cells[i] ?? ''])
      );
      return importedRow(row, `${file}:${index + 2}`);
    });
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim() === '') return [];
    const source = `${file}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${source} isn't JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`${source} isn't a JSON object.`);
    const record = value as Record<string, unknown>;
    return format === 'judgekeeper'
      ? judgekeeperLabel(record, source)
      : importedRow(record, source);
  });
}

/**
 * A name as written: the judge, criterion, variant, case or baseline, which
 * may have spaces at either end. Empty is missing.
 */
function exact(value: unknown): string | undefined {
  const string =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? String(value)
        : '';
  return string === '' ? undefined : string;
}

/** A cell or field as text: strings, numbers and booleans; anything else is missing. */
function text(value: unknown): string | undefined {
  const string =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  return string === '' ? undefined : string;
}

function importedRow(
  row: Record<string, unknown>,
  source: string
): ImportedLabel[] {
  const label = text(row.label);
  if (label === undefined) return [];
  const required = (name: string): string => {
    const value = exact(row[name]);
    if (value === undefined) throw new Error(`${source} has no ${name}.`);
    return value;
  };
  const trial = text(row.trial);
  const baseline = exact(row.baseline);
  if (trial === undefined && baseline === undefined)
    throw new Error(
      `${source} has neither a trial (a judge's label) nor a baseline (a pairwise judge's).`
    );
  return [
    {
      judge: required('judge'),
      ...optional('criterion', exact(row.criterion)),
      variant: required('variant'),
      caseId: required('caseId'),
      ...(trial !== undefined ? { trial: trialNumber(trial, source) } : {}),
      ...optional('baseline', baseline),
      label,
      ...optional('split', text(row.split)),
      ...optional('labeler', text(row.labeler)),
      ...optional('labeledAt', text(row.labeledAt)),
      ...optional('note', text(row.note)),
      source,
    },
  ];
}

function trialNumber(value: string, source: string): number {
  const trial = Number(value);
  if (!Number.isInteger(trial) || trial < 0)
    throw new Error(
      `${source}: trial "${value}" isn't a trial index (0, 1, ...).`
    );
  return trial;
}

/** A judgekeeper `HUMAN` record as a label; other records are skipped. */
function judgekeeperLabel(
  record: Record<string, unknown>,
  source: string
): ImportedLabel[] {
  if (text(record.annotator_kind)?.toUpperCase() !== 'HUMAN') return [];
  const label = text(record.label);
  if (label === undefined) return [];
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const mst = (metadata.mst ?? {}) as Record<string, unknown>;
  let variant = exact(mst.variant);
  let caseId = exact(mst.caseId);
  let trial = text(mst.trial);
  if (variant === undefined || caseId === undefined || trial === undefined) {
    const target = text(record.target_id) ?? '';
    const parts = target.split('/');
    if (parts.length !== 3)
      throw new Error(
        `${source}: target_id ${JSON.stringify(target)} isn't one mst label export wrote (<variant>/<case-id>/<trial>).`
      );
    [variant, caseId, trial] = parts.map((part) => decodeURIComponent(part));
  }
  const name = exact(record.name) ?? 'judge';
  const hash = name.lastIndexOf('#');
  const criterion =
    exact(mst.criterion) ?? (hash > 0 ? name.slice(hash + 1) : undefined);
  const judge =
    criterion !== undefined && name.endsWith(`#${criterion}`)
      ? name.slice(0, -(criterion.length + 1))
      : name;
  return [
    {
      judge,
      ...optional('criterion', criterion),
      variant: variant!,
      caseId: caseId!,
      trial: trialNumber(trial!, source),
      label,
      ...optional('split', text(mst.split)),
      ...optional('labeler', text(mst.labeler)),
      ...optional('labeledAt', text(record.created_at)),
      ...optional('note', text(mst.note)),
      source,
    },
  ];
}

const POINTWISE_SPELLINGS = new Map<string, PointwiseLabel>([
  ['pass', 'pass'],
  ['fail', 'fail'],
  ['true', 'pass'],
  ['false', 'fail'],
  ['yes', 'pass'],
  ['no', 'fail'],
  ['1', 'pass'],
  ['0', 'fail'],
]);

/** The options of `checkImportedLabels`. */
export interface LabelImportOptions {
  /** Who gave labels that don't say. @default the OS user name */
  labeler?: string;
  /** When labels that don't say were given. @default now */
  now?: Date;
}

/**
 * Checks imported labels against the run: each one must label a verdict the
 * run has, with a value its judge can give. Returns them as the run stores
 * them. A label that replaces one keeps its split unless it gives its own.
 * Throws, importing none, when any label can't be imported.
 */
export function checkImportedLabels(
  imported: readonly ImportedLabel[],
  items: readonly JudgedItem[],
  existing: readonly LabelRecord[],
  options: LabelImportOptions = {}
): LabelRecord[] {
  const known = new Set(
    items
      .filter((item) => item.verdict !== undefined)
      .map((item) => labelKey(item))
  );
  const judges = [...new Set(items.map((item) => labelQuestion(item)))].sort();
  const previous = new Map(existing.map((label) => [labelKey(label), label]));
  const labeler = options.labeler ?? os.userInfo().username;
  const labeledAt = (options.now ?? new Date()).toISOString();
  const problems: string[] = [];
  const labels: LabelRecord[] = [];
  const seen = new Map<string, string>();
  for (const label of imported) {
    const key = labelKey(label);
    if (!known.has(key)) {
      problems.push(
        `${label.source}: the run has no verdict from "${labelQuestion(label)}" for ${describe(label)}${judges.length ? ` (its judges: ${judges.join(', ')})` : ''}.`
      );
      continue;
    }
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      problems.push(`${label.source} labels what ${earlier} labels.`);
      continue;
    }
    seen.set(key, label.source);
    const split = label.split ?? previous.get(key)?.split;
    if (split !== undefined && !LABEL_SPLITS.includes(split as LabelSplit)) {
      problems.push(
        `${label.source}: split "${split}" isn't ${LABEL_SPLITS.join(' or ')}.`
      );
      continue;
    }
    const fields = {
      format: RUN_FORMAT,
      kind: 'label' as const,
      judge: label.judge,
      ...optional('criterion', label.criterion),
      variant: label.variant,
      caseId: label.caseId,
      split: (split ?? defaultSplit(label.caseId)) as LabelSplit,
      labeler: label.labeler ?? labeler,
      labeledAt: label.labeledAt ?? labeledAt,
      ...optional('note', label.note),
    };
    let record: LabelRecord;
    if (label.trial !== undefined) {
      const value = POINTWISE_SPELLINGS.get(label.label.toLowerCase());
      if (value === undefined) {
        problems.push(
          `${label.source}: label "${label.label}" isn't pass or fail.`
        );
        continue;
      }
      record = { ...fields, trial: label.trial, label: value };
    } else {
      const value = label.label.toLowerCase();
      if (!PAIRWISE_LABELS.includes(value as PairwiseLabel)) {
        problems.push(
          `${label.source}: label "${label.label}" isn't ${PAIRWISE_LABELS.join(', ')}.`
        );
        continue;
      }
      record = {
        ...fields,
        baseline: label.baseline!,
        label: value as PairwiseLabel,
      };
    }
    // What the run will store, and where: both checked before any is written.
    try {
      parseLabelRecord(record, label.source);
      labelRecordPath(keyOf(record) as LabelPathFields);
    } catch (error) {
      problems.push(
        `${label.source} can't be stored: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    labels.push(record);
  }
  if (problems.length) {
    const shown = problems.slice(0, 10);
    throw new Error(
      [
        `${problems.length} label${problems.length === 1 ? '' : 's'} can't be imported, so none were:`,
        ...shown.map((problem) => `  ${problem}`),
        ...(problems.length > shown.length
          ? [`  ...and ${problems.length - shown.length} more.`]
          : []),
      ].join('\n')
    );
  }
  return labels;
}

function describe(label: ImportedLabel): string {
  return label.trial !== undefined
    ? `trial ${label.trial} of case "${label.caseId}" on variant "${label.variant}"`
    : `case "${label.caseId}" on variant "${label.variant}" against "${label.baseline}"`;
}

/** The format a file's name suggests, for `--format`'s default. */
export function formatOfFile(file: string): LabelFormat | undefined {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl';
  return undefined;
}

/** Whether JSONL text holds judgekeeper records rather than MST's rows. */
export function looksLikeJudgekeeper(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '');
  if (!first) return false;
  try {
    const value = JSON.parse(first) as Record<string, unknown>;
    return 'annotator_kind' in value || 'schema_version' in value;
  } catch {
    return false;
  }
}

/**
 * A CSV cell. A text cell that a spreadsheet would run as a formula gets a
 * leading `'`, which `parseCsv` removes again.
 */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let cell = String(value);
  if (typeof value === 'string' && /^['=+\-@\t\r]/.test(cell))
    cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** RFC 4180 CSV: quoted cells may hold commas, quotes and line breaks. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const endCell = () => {
    row.push(/^'['=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);
    cell = '';
    wasQuoted = false;
  };
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\n') line++;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        const next = text[i + 1];
        if (next !== undefined && !/[,\r\n]/.test(next))
          throw new Error(
            `CSV line ${line}: a quoted cell must end at a comma or line break.`
          );
      } else cell += char;
    } else if (char === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endCell();
      rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted)
    throw new Error(
      `CSV line ${line}: a quoted cell has no closing quote, so the rows after it would be lost.`
    );
  if (cell !== '' || wasQuoted || row.length) {
    endCell();
    rows.push(row);
  }
  return rows;
}
