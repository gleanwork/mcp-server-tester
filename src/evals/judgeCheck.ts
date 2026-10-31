/**
 * `mst judges check` (ADR 0009): how well a judge agrees with a person's
 * labels, and whether it is usable.
 *
 * For a pointwise judge, a failing trial is the positive class, because
 * catching failures is what a judge is for:
 *
 * - TPR: of the trials people failed, the share the judge failed.
 * - TNR: of the trials people passed, the share the judge passed.
 *
 * Each rate has a 95% Wilson interval. A judge is usable when it has enough
 * labels of each kind, both lower bounds reach the minimum rate, and it
 * answers `unknown` rarely enough. A calibration applies to one judge
 * identity; a changed judge is checked again.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../utils/jsonFile.js';
import { RUN_FORMAT } from './resultFormat.js';
import {
  calibrationRecordPath,
  labelQuestion,
  parseCalibrationRecord,
  type CalibrationRecord,
  type LabelRecord,
  type StoredRun,
} from './runFormat.js';
import { labelKey, type JudgedItem } from './judgedItems.js';

/** What `checkJudge` needs of one run. */
export interface CheckedRun {
  stored: StoredRun;
  items: readonly JudgedItem[];
  labels: readonly LabelRecord[];
}

/** The gate a usable judge passes. Each number can be changed. */
export interface UsableGate {
  /** Labels people passed, at least. @default 15 */
  minPassLabels: number;
  /** Labels people failed, at least. @default 15 */
  minFailLabels: number;
  /** The lower bound of TPR and of TNR, at least. @default 0.8 */
  minRate: number;
  /** The share of labeled trials the judge answered `unknown`, at most. @default 0.1 */
  maxUnknownRate: number;
}

const DEFAULT_GATE: UsableGate = {
  minPassLabels: 15,
  minFailLabels: 15,
  minRate: 0.8,
  maxUnknownRate: 0.1,
};

/** A share with its 95% Wilson interval; null without a sample. */
export interface Rate {
  k: number;
  n: number;
  value: number | null;
  low: number | null;
  high: number | null;
}

const Z95 = 1.959963984540054;

/** The Wilson score interval for `k` of `n` (95% by default). */
export function wilson(k: number, n: number, z = Z95): Rate {
  if (n === 0) return { k, n, value: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    k,
    n,
    value: p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

/** The counts of a pointwise judge against labels, failing as positive. */
export interface ConfusionCounts {
  /** People failed it; the judge failed it. */
  truePositive: number;
  /** People failed it; the judge passed it. */
  falseNegative: number;
  /** People passed it; the judge passed it. */
  trueNegative: number;
  /** People passed it; the judge failed it. */
  falsePositive: number;
}

/** Cohen's kappa for two raters on two classes; null when chance explains everything. */
export function cohensKappa(counts: ConfusionCounts): number | null {
  const { truePositive, falseNegative, trueNegative, falsePositive } = counts;
  const n = truePositive + falseNegative + trueNegative + falsePositive;
  if (n === 0) return null;
  const observed = (truePositive + trueNegative) / n;
  const expected =
    ((truePositive + falseNegative) * (truePositive + falsePositive) +
      (trueNegative + falsePositive) * (trueNegative + falseNegative)) /
    (n * n);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

/** A labeled verdict the judge and the person disagree on. */
interface Disagreement {
  runId: string;
  variant: string;
  caseId: string;
  trial?: number;
  baseline?: string;
  verdict: string;
  label: string;
  reasoning?: string;
}

interface CheckBase {
  judge: string;
  /** Absent for verdicts from before MST recorded identities: nothing to record. */
  judgeIdentity?: string;
  /** MST can't see the judge's version change, so staleness can't be told. */
  unversioned: boolean;
  judgeModels: string[];
  runs: string[];
  split: 'test' | 'dev' | 'all';
  /** Labels whose verdict the runs don't have (the judge failed, or was graded again without it). */
  unmatched: number;
  disagreements: Disagreement[];
}

export interface PointwiseCheck extends CheckBase {
  kind: 'pointwise';
  labels: number;
  humanPass: number;
  humanFail: number;
  counts: ConfusionCounts;
  tpr: Rate;
  tnr: Rate;
  kappa: number | null;
  unknown: Rate;
  gate: UsableGate;
  usable: boolean;
  /** Why it isn't usable; empty when it is. */
  reasons: string[];
}

export interface PairwiseCheck extends CheckBase {
  kind: 'pairwise';
  labels: number;
  /** The share of labels the judge's preference matches. */
  agreement: Rate;
  /** How often each side called a tie. */
  judgeTies: Rate;
  humanTies: Rate;
  unknown: Rate;
}

export type JudgeCheck = PointwiseCheck | PairwiseCheck;

export interface CheckJudgeOptions {
  judge: string;
  /** The labels to use. @default 'test' */
  split?: 'test' | 'dev' | 'all';
  gate?: Partial<UsableGate>;
}

/**
 * Checks a judge against the labels in `runs`: one result per judge identity
 * the runs' verdicts have, newest runs' identity first.
 *
 * Each label counts once per identity: a run given twice is read once, and
 * when a run and its regrades (which share its traces and labels) gave the
 * same identity's verdict for a label, only the newest run's counts.
 */
export function checkJudge(
  runs: readonly CheckedRun[],
  options: CheckJudgeOptions
): JudgeCheck[] {
  const split = options.split ?? 'test';
  const gate = { ...DEFAULT_GATE, ...options.gate };
  const groups = new Map<
    string,
    {
      identity?: string;
      unversioned: boolean;
      models: Set<string>;
      runs: Set<string>;
      /** By the trace's run and the label's key. */
      pairs: Map<string, Pair>;
    }
  >();
  let unmatched = 0;
  const ordered = [
    ...new Map(runs.map((run) => [run.stored.run.runId, run])).values(),
  ].sort((a, b) =>
    a.stored.run.createdAt.localeCompare(b.stored.run.createdAt)
  );
  for (const run of ordered) {
    const runId = run.stored.run.runId;
    const traces = run.stored.run.gradedFrom ?? runId;
    const items = new Map(
      run.items
        .filter((item) => labelQuestion(item) === options.judge)
        .map((item) => [labelKey(item), item])
    );
    for (const label of run.labels) {
      if (labelQuestion(label) !== options.judge) continue;
      if (split !== 'all' && label.split !== split) continue;
      const item = items.get(labelKey(label));
      if (!item?.verdict) {
        unmatched++;
        continue;
      }
      // Each verdict's own identity: a regrade can keep verdicts an older
      // judge gave, so the run's current judges don't say whose they are.
      const identity = item.judgeIdentity;
      const key = identity ?? '';
      let group = groups.get(key);
      if (!group) {
        group = {
          ...(identity !== undefined ? { identity } : {}),
          unversioned: false,
          models: new Set(),
          runs: new Set(),
          pairs: new Map(),
        };
        groups.set(key, group);
      }
      if (item.judgeUnversioned === true) group.unversioned = true;
      if (item.judgeModel) group.models.add(item.judgeModel);
      group.pairs.set(JSON.stringify([traces, labelKey(label)]), {
        item,
        label,
        runId,
      });
    }
  }
  const order = ordered.map((run) => run.stored.run.runId);
  for (const group of groups.values())
    for (const pair of group.pairs.values()) group.runs.add(pair.runId);
  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: [...group.runs].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      pairs: [...group.pairs.values()],
    }))
    .sort(
      (a, b) => order.indexOf(b.runs.at(-1)!) - order.indexOf(a.runs.at(-1)!)
    )
    .map((group) => {
      const base = {
        judge: options.judge,
        ...(group.identity !== undefined
          ? { judgeIdentity: group.identity }
          : {}),
        unversioned: group.unversioned,
        judgeModels: [...group.models].sort(),
        runs: group.runs,
        split,
        unmatched,
      };
      return group.pairs.some(({ item }) => item.baseline !== undefined)
        ? pairwiseCheck(base, group.pairs)
        : pointwiseCheck(base, group.pairs, gate);
    });
}

type Pair = { item: JudgedItem; label: LabelRecord; runId: string };

function disagreement({ item, label, runId }: Pair): Disagreement {
  return {
    runId,
    variant: item.variant,
    caseId: item.caseId,
    ...(item.trial !== undefined ? { trial: item.trial } : {}),
    ...(item.baseline !== undefined ? { baseline: item.baseline } : {}),
    verdict: item.verdict!,
    label: label.label,
    ...(item.reasoning !== undefined ? { reasoning: item.reasoning } : {}),
  };
}

function pointwiseCheck(
  base: Omit<CheckBase, 'disagreements'>,
  pairs: Pair[],
  gate: UsableGate
): PointwiseCheck {
  const counts: ConfusionCounts = {
    truePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    falsePositive: 0,
  };
  let unknown = 0;
  let humanPass = 0;
  let humanFail = 0;
  const disagreements: Disagreement[] = [];
  for (const pair of pairs) {
    const failed = pair.label.label === 'fail';
    if (failed) humanFail++;
    else humanPass++;
    if (pair.item.verdict === 'unknown') {
      unknown++;
      continue;
    }
    const judgeFailed = pair.item.verdict === 'fail';
    if (failed && judgeFailed) counts.truePositive++;
    else if (failed) counts.falseNegative++;
    else if (judgeFailed) counts.falsePositive++;
    else counts.trueNegative++;
    if (failed !== judgeFailed) disagreements.push(disagreement(pair));
  }
  const tpr = wilson(
    counts.truePositive,
    counts.truePositive + counts.falseNegative
  );
  const tnr = wilson(
    counts.trueNegative,
    counts.trueNegative + counts.falsePositive
  );
  const unknownRate = wilson(unknown, pairs.length);
  const reasons: string[] = [];
  const decidedPass = counts.trueNegative + counts.falsePositive;
  const decidedFail = counts.truePositive + counts.falseNegative;
  if (decidedFail < gate.minFailLabels)
    reasons.push(
      `${decidedFail} failing label${decidedFail === 1 ? '' : 's'} with a verdict; it needs ${gate.minFailLabels}`
    );
  if (decidedPass < gate.minPassLabels)
    reasons.push(
      `${decidedPass} passing label${decidedPass === 1 ? '' : 's'} with a verdict; it needs ${gate.minPassLabels}`
    );
  if (tpr.low !== null && tpr.low < gate.minRate)
    reasons.push(
      `TPR's lower bound ${tpr.low.toFixed(2)} is below ${gate.minRate}`
    );
  if (tnr.low !== null && tnr.low < gate.minRate)
    reasons.push(
      `TNR's lower bound ${tnr.low.toFixed(2)} is below ${gate.minRate}`
    );
  if (unknownRate.value !== null && unknownRate.value > gate.maxUnknownRate)
    reasons.push(
      `it answered unknown on ${(unknownRate.value * 100).toFixed(0)}% of labeled trials; at most ${gate.maxUnknownRate * 100}% is allowed`
    );
  return {
    kind: 'pointwise',
    ...base,
    labels: pairs.length,
    humanPass,
    humanFail,
    counts,
    tpr,
    tnr,
    kappa: cohensKappa(counts),
    unknown: unknownRate,
    gate,
    usable: reasons.length === 0,
    reasons,
    disagreements,
  };
}

function pairwiseCheck(
  base: Omit<CheckBase, 'disagreements'>,
  pairs: Pair[]
): PairwiseCheck {
  let agree = 0;
  let decided = 0;
  let unknown = 0;
  let judgeTies = 0;
  let humanTies = 0;
  const disagreements: Disagreement[] = [];
  for (const pair of pairs) {
    if (pair.label.label === 'tie') humanTies++;
    if (pair.item.verdict === 'unknown') {
      unknown++;
      continue;
    }
    decided++;
    if (pair.item.verdict === 'tie') judgeTies++;
    if (pair.item.verdict === pair.label.label) agree++;
    else disagreements.push(disagreement(pair));
  }
  return {
    kind: 'pairwise',
    ...base,
    labels: pairs.length,
    agreement: wilson(agree, decided),
    judgeTies: wilson(judgeTies, decided),
    humanTies: wilson(humanTies, pairs.length),
    unknown: wilson(unknown, pairs.length),
    disagreements,
  };
}

/** A check as the calibration record a run's eval keeps for the judge's identity. */
export function calibrationRecord(
  check: JudgeCheck & { judgeIdentity: string },
  now: Date = new Date()
): CalibrationRecord {
  const common = {
    format: RUN_FORMAT,
    kind: 'calibration' as const,
    judge: check.judge,
    judgeIdentity: check.judgeIdentity,
    ...(check.unversioned ? { unversioned: true as const } : {}),
    judgeModels: check.judgeModels,
    createdAt: now.toISOString(),
    runs: check.runs,
    split: check.split,
    labels: check.labels,
    unknown: check.unknown,
  };
  return check.kind === 'pointwise'
    ? {
        ...common,
        judgeKind: 'pointwise',
        humanPass: check.humanPass,
        humanFail: check.humanFail,
        counts: check.counts,
        tpr: check.tpr,
        tnr: check.tnr,
        kappa: check.kappa,
        gate: check.gate,
        usable: check.usable,
        reasons: check.reasons,
      }
    : {
        ...common,
        judgeKind: 'pairwise',
        agreement: check.agreement,
        judgeTies: check.judgeTies,
        humanTies: check.humanTies,
      };
}

/** A corrected pass rate and its 95% interval. */
export interface CorrectedRate {
  value: number;
  low: number;
  high: number;
}

/**
 * The share of trials that would pass by people's labels, from the share the
 * judge passed and its calibration: the Rogan-Gladen estimator, with failing
 * as the positive class, cut to [0, 1].
 *
 * The 95% interval is Lang and Reiczigel's (2014), which accounts for the
 * run's sample and the calibration's two: the delta method's, on rates
 * adjusted as Agresti and Coull adjust a proportion (adding z²/2 failures
 * and z²/2 passes to the run, and one of each to TPR's and TNR's labels),
 * with their bias correction. The plain delta method gives a zero-width
 * interval when a rate is 0 or 1, as it is for a judge that agrees with
 * every label on a run that passes every trial.
 *
 * Undefined when the judge does no better than chance (TPR + TNR <= 1),
 * since nothing then separates passes from failures.
 */
export function correctedPassRate(
  passed: number,
  judged: number,
  calibration: { tpr: Rate; tnr: Rate },
  z = Z95
): CorrectedRate | undefined {
  const { tpr, tnr } = calibration;
  if (judged === 0 || tpr.value === null || tnr.value === null)
    return undefined;
  const youden = tpr.value + tnr.value - 1;
  if (youden <= 0) return undefined;
  const failed = 1 - passed / judged;
  const fail = clip((failed + tnr.value - 1) / youden);

  // Lang and Reiczigel's adjusted rates (their eqs 6 and 7).
  const z2 = z * z;
  const nTpr = tpr.n + 2;
  const nTnr = tnr.n + 2;
  const adjTpr = (tpr.k + 1) / nTpr;
  const adjTnr = (tnr.k + 1) / nTnr;
  const nRun = judged + z2;
  const adjFailed = (judged * failed + z2 / 2) / nRun;
  const adjYouden = adjTpr + adjTnr - 1;
  if (adjYouden <= 0) return undefined;
  const adjFail = (adjFailed + adjTnr - 1) / adjYouden;
  // Their bias correction (eq 17) and variance (eq 4, on adjusted rates).
  const shift =
    2 *
    z2 *
    ((adjFail * adjTpr * (1 - adjTpr)) / nTpr -
      ((1 - adjFail) * adjTnr * (1 - adjTnr)) / nTnr);
  const variance =
    ((adjFailed * (1 - adjFailed)) / nRun +
      (adjFail * adjFail * adjTpr * (1 - adjTpr)) / nTpr +
      ((1 - adjFail) * (1 - adjFail) * adjTnr * (1 - adjTnr)) / nTnr) /
    (adjYouden * adjYouden);
  const half = z * Math.sqrt(variance);
  return {
    value: 1 - fail,
    low: 1 - clip(adjFail + shift + half),
    high: 1 - clip(adjFail + shift - half),
  };
}

function clip(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** An eval's directory, from one of its run directories (`<eval>/runs/<run-id>`). */
export function evalDirectoryOf(runDirectory: string): string {
  return path.dirname(path.dirname(path.resolve(runDirectory)));
}

/** Writes a calibration record into an eval's directory; returns its file. */
export async function writeCalibration(
  evalDirectory: string,
  record: CalibrationRecord
): Promise<string> {
  const file = path.join(evalDirectory, calibrationRecordPath(record));
  await writeJsonFile(file, record);
  return file;
}

/**
 * When an eval's newest calibration was written, in ms since the epoch: a
 * report built before it doesn't show it. Undefined without calibrations.
 */
export async function newestCalibrationTime(
  evalDirectory: string
): Promise<number | undefined> {
  const root = path.join(evalDirectory, 'calibrations');
  const judges = await fs.readdir(root).catch(() => [] as string[]);
  let newest: number | undefined;
  for (const judge of judges) {
    const directory = path.join(root, judge);
    for (const name of await fs
      .readdir(directory)
      .catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const info = await fs.stat(path.join(directory, name)).catch(() => null);
      if (info && (newest === undefined || info.mtimeMs > newest))
        newest = info.mtimeMs;
    }
  }
  return newest;
}

/**
 * Every calibration an eval keeps, for the report. A file that isn't one is
 * left out with a warning, so one bad file doesn't stop a report.
 */
export async function readCalibrations(
  evalDirectory: string,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<CalibrationRecord[]> {
  const root = path.join(evalDirectory, 'calibrations');
  let judges: string[];
  try {
    judges = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CalibrationRecord[] = [];
  for (const judge of judges.sort()) {
    const directory = path.join(root, judge);
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of files.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      try {
        records.push(parseCalibrationRecord(await readJsonFile(file), file));
      } catch (error) {
        warn(
          `[mcp-server-tester] Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return records;
}

/**
 * The calibration an eval keeps for a judge identity, if any: what the
 * report shows as current. Undefined when the identity was never checked.
 */
export async function readCalibration(
  evalDirectory: string,
  judge: string,
  judgeIdentity: string
): Promise<CalibrationRecord | undefined> {
  const file = path.join(
    evalDirectory,
    calibrationRecordPath({ judge, judgeIdentity })
  );
  let value: unknown;
  try {
    value = await readJsonFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseCalibrationRecord(value, file);
}
