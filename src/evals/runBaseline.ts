import { RESULT_SCHEMA_VERSION } from './resultFormat.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  EvaluationSummary,
  PreviousRunComparison,
  PreviousRunVariant,
} from './evalFrameworkTypes.js';
import { compareEvalRuns } from './evalRunComparison.js';
import type { EvalResultStore } from './resultStore.js';

/** A previous run's summary and ID. */
interface PreviousRun {
  runId: string;
  summary: EvaluationSummary;
}

/** A summary of the eval config that ran the same variants (a `--variant` run compares with `--variant` runs). */
function isComparable(
  value: unknown,
  configId: string,
  variants: string[]
): value is EvaluationSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as EvaluationSummary;
  // A run in an older result format isn't a baseline.
  if (summary.schemaVersion !== RESULT_SCHEMA_VERSION) return false;
  if (summary.configId !== configId || !Array.isArray(summary.variants))
    return false;
  const names = summary.variants.map((variant) => variant.name).sort();
  return names.join('\0') === [...variants].sort().join('\0');
}

/**
 * The newest earlier run of the eval config: from the result store when the
 * eval config has one, else from the `results.json` files beside this run's
 * output directory. Never another eval config's run.
 */
export async function findPreviousRun(options: {
  configId: string;
  runId: string;
  /** This run's variant names: only a run of the same variants is comparable. */
  variants: string[];
  store?: EvalResultStore;
  outputRoot: string;
}): Promise<PreviousRun | undefined> {
  if (options.store) {
    const candidates = (await options.store.listArtifacts('eval-run-summary'))
      .filter(
        (artifact) =>
          artifact.id !== options.runId &&
          artifact.metadata?.labels?.configId === options.configId
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const candidate of candidates) {
      try {
        const artifact = await options.store.loadArtifact(
          'eval-run-summary',
          candidate.id
        );
        if (isComparable(artifact.data, options.configId, options.variants))
          return { runId: candidate.id, summary: artifact.data };
      } catch {
        // An unreadable or half-written summary isn't a baseline.
      }
    }
    return undefined;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(options.outputRoot);
  } catch {
    return undefined;
  }
  const runs: PreviousRun[] = [];
  for (const entry of entries) {
    if (entry === options.runId) continue;
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(
          path.join(options.outputRoot, entry, 'results.json'),
          'utf8'
        )
      );
      if (isComparable(value, options.configId, options.variants))
        runs.push({ runId: value.runId ?? entry, summary: value });
    } catch {
      // Not a run directory, or an unreadable one: not a baseline.
    }
  }
  return runs.sort((a, b) =>
    b.summary.timestamp.localeCompare(a.summary.timestamp)
  )[0];
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
    variants[variant.name] = {
      passRateDelta: comparison.deltaPassRate,
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
