import { RUN_FORMAT } from './resultFormat.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  EvaluationSummary,
  PreviousRunComparison,
  PreviousRunVariant,
} from './evalFrameworkTypes.js';
import { compareEvalRuns } from './evalRunComparison.js';
import type { EvalResultStore } from './resultStore.js';
import { joinCaseResults } from './runFormat.js';
import { readJsonFile } from '../utils/jsonFile.js';
import {
  DEFAULT_REGRESSION_TAG,
  headlineGroup,
  measureAgainstBaseline,
} from './variantComparison.js';
import type { EvalCaseResult } from '../types/reporter.js';

/** A previous run's summary and ID. */
interface PreviousRun {
  runId: string;
  summary: EvaluationSummary;
}

/** A summary of the eval config that ran the same variants (a `--variant` run compares with `--variant` runs). */
function isComparable(
  value: unknown,
  configId: string,
  variants: string[],
  selection: { partial?: boolean; selectionHash?: string } = {}
): value is EvaluationSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as EvaluationSummary;
  // A run in an older result format isn't a baseline.
  if (summary.format !== RUN_FORMAT) return false;
  // An ungraded run's passes aren't results, and a run with missing trials
  // (a shard that ended early) isn't one either: it never becomes the latest.
  if (summary.graded === false) return false;
  const incomplete: unknown = summary.metrics?.incomplete;
  if (typeof incomplete === 'number' && incomplete > 0) return false;
  if (summary.configId !== configId || !Array.isArray(summary.variants))
    return false;
  // A full run compares with full runs; a partial run with partial runs
  // narrowed the same way.
  if ((summary.partial ?? false) !== (selection.partial ?? false)) return false;
  if (selection.partial && summary.selectionHash !== selection.selectionHash)
    return false;
  const names = summary.variants.map((variant) => variant.name).sort();
  return names.join('\0') === [...variants].sort().join('\0');
}

/**
 * An eval's runs, wherever they're kept: a local `runs/` directory, or a
 * result store (`storeRunHistory`).
 */
export interface RunHistory {
  /** The IDs of the eval's runs, in any order. */
  runIds(): Promise<string[]>;
  /** A run's `summary.json`, or undefined when it has none. */
  summary(runId: string): Promise<unknown>;
  /** A run's case results, from its `results.json`. */
  cases(runId: string): Promise<EvalCaseResult[]>;
}

/** The runs in a local `runs/` directory. */
function localRunHistory(runsDirectory: string): RunHistory {
  return {
    runIds: () => fs.readdir(runsDirectory),
    async summary(runId) {
      const value: unknown = JSON.parse(
        await fs.readFile(
          path.join(runsDirectory, runId, 'summary.json'),
          'utf8'
        )
      );
      return value;
    },
    async cases(runId) {
      // In chunks: a run's results can pass V8's string limit.
      const results = (await readJsonFile(
        path.join(runsDirectory, runId, 'results.json')
      )) as { cases?: EvalCaseResult[] };
      return results.cases ?? [];
    },
  };
}

/**
 * The newest earlier run of the eval config: from `history` (a result store
 * that holds runs) when given, else from an artifact `store` (the Playwright
 * reporter's), else from the other runs in this eval's `runs/` directory
 * (their `summary.json` and `results.json`). Never another eval config's run.
 */
export async function findPreviousRun(options: {
  configId: string;
  runId: string;
  /** This run's variant names: only a run of the same variants is comparable. */
  variants: string[];
  /** Whether this run is partial, and how it was narrowed. */
  partial?: boolean;
  selectionHash?: string;
  history?: RunHistory;
  store?: EvalResultStore;
  outputRoot: string;
  /**
   * For a regrade: the run that collected its traces, and when. That run's
   * gradings (it and its `.g<n>` regrades) come first; failing those, a run
   * collected before it. Never a run collected after it.
   */
  regradeOf?: { runId: string; collectedAt: string };
}): Promise<PreviousRun | undefined> {
  const regradeOf = options.regradeOf;
  const sameTraces = (runId: string | undefined) =>
    regradeOf !== undefined &&
    runId?.replace(/\.g\d+$/, '') === regradeOf.runId;
  // Another grading of the same traces always is; another run, only one
  // collected no later.
  const eligible = (summary: EvaluationSummary) =>
    regradeOf === undefined ||
    sameTraces(summary.runId) ||
    (summary.collectedAt ?? summary.timestamp) <= regradeOf.collectedAt;
  const rank = (runId: string) => (sameTraces(runId) ? 0 : 1);
  if (!options.history && options.store) {
    const candidates = (await options.store.listArtifacts('eval-run-summary'))
      .filter(
        (artifact) =>
          artifact.id !== options.runId &&
          artifact.metadata?.labels?.configId === options.configId
      )
      .sort(
        (a, b) =>
          rank(a.id) - rank(b.id) || b.createdAt.localeCompare(a.createdAt)
      );
    for (const candidate of candidates) {
      try {
        const artifact = await options.store.loadArtifact(
          'eval-run-summary',
          candidate.id
        );
        if (
          isComparable(
            artifact.data,
            options.configId,
            options.variants,
            options
          ) &&
          eligible(artifact.data)
        )
          return { runId: candidate.id, summary: artifact.data };
      } catch {
        // An unreadable or half-written summary isn't a baseline.
      }
    }
    return undefined;
  }
  const history = options.history ?? localRunHistory(options.outputRoot);
  let entries: string[];
  try {
    entries = await history.runIds();
  } catch {
    return undefined;
  }
  // Summaries pick the run; only that run's case results are read.
  const runs = (
    await Promise.all(
      entries
        .filter((entry) => entry !== options.runId)
        .map(async (entry) => {
          try {
            const value = await history.summary(entry);
            return isComparable(
              value,
              options.configId,
              options.variants,
              options
            ) && eligible(value)
              ? [{ entry, runId: value.runId ?? entry, summary: value }]
              : [];
          } catch {
            // Not a run directory, or an unreadable one: not a baseline.
            return [];
          }
        })
    )
  )
    .flat()
    .sort(
      (a, b) =>
        rank(a.runId) - rank(b.runId) ||
        b.summary.timestamp.localeCompare(a.summary.timestamp)
    );
  const newest = runs[0];
  if (!newest) return undefined;
  // A run without results.json compares as having no cases.
  const cases = await history.cases(newest.entry).catch(() => []);
  return {
    runId: newest.runId,
    summary: joinCaseResults(newest.summary, cases),
  };
}

function metric(
  variant: { metrics?: Record<string, unknown> },
  key: string
): number | undefined {
  const value = variant.metrics?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Case IDs, once each (a case ID may repeat across a variant's datasets). */
function ids(cases: Array<{ id: string }>): string[] {
  return [...new Set(cases.map((c) => c.id))];
}

/** This run against a previous one, variant by variant. */
export function compareWithPrevious(
  previous: PreviousRun,
  current: EvaluationSummary
): PreviousRunComparison {
  const before = new Map(
    previous.summary.variants.map((variant) => [variant.name, variant])
  );
  const variants: Record<string, PreviousRunVariant> = {};
  for (const variant of current.variants) {
    const prior = before.get(variant.name);
    if (!prior?.result || !variant.result) continue;
    const comparison = compareEvalRuns({
      baseline: prior.result,
      candidate: variant.result,
    });
    const now = metric(variant, 'trial_pass_rate');
    const then = metric(prior, 'trial_pass_rate');
    // The same paired test, on the same cases, as the report's variant
    // comparisons, so one page never judges a change two ways.
    const change = headlineGroup(
      measureAgainstBaseline(prior.result, variant.result, {
        grouping: { source: 'declared', tag: DEFAULT_REGRESSION_TAG },
      })
    ).change;
    variants[variant.name] = {
      passRateDelta: comparison.deltaPassRate,
      ...(change ? { change } : {}),
      ...(now !== undefined && then !== undefined
        ? { trialPassRateDelta: now - then }
        : {}),
      regressed: ids(comparison.regressedCases),
      improved: ids(comparison.improvedCases),
      added: ids(comparison.missingFromBaseline),
      removed: ids(comparison.missingFromCandidate),
    };
  }
  const passRate = metric(previous.summary, 'passRate') ?? 0;
  return {
    runId: previous.runId,
    timestamp: previous.summary.timestamp,
    sameConfig: previous.summary.contentHash === current.contentHash,
    passRate,
    passRateDelta: (metric(current, 'passRate') ?? 0) - passRate,
    variants,
  };
}
