import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  EvaluationSummary,
  PreviousRunComparison,
  PreviousRunArm,
} from './evalFrameworkTypes.js';
import { compareEvalRuns } from './evalRunComparison.js';
import type { EvalResultStore } from './resultStore.js';

/** A previous run's summary and ID. */
interface PreviousRun {
  runId: string;
  summary: EvaluationSummary;
}

/** A summary of the manifest that ran the same arms (an `--arm` run compares with `--arm` runs). */
function isComparable(
  value: unknown,
  manifestId: string,
  arms: string[]
): value is EvaluationSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as EvaluationSummary;
  if (summary.manifestId !== manifestId || !Array.isArray(summary.arms))
    return false;
  const names = summary.arms.map((arm) => arm.name).sort();
  return names.join('\0') === [...arms].sort().join('\0');
}

/**
 * The newest earlier run of the manifest: from the result store when the
 * manifest has one, else from the `results.json` files beside this run's
 * output directory. Never another manifest's run.
 */
export async function findPreviousRun(options: {
  manifestId: string;
  runId: string;
  /** This run's arm names: only a run of the same arms is comparable. */
  arms: string[];
  store?: EvalResultStore;
  outputRoot: string;
}): Promise<PreviousRun | undefined> {
  if (options.store) {
    const candidates = (await options.store.listArtifacts('eval-run-summary'))
      .filter(
        (artifact) =>
          artifact.id !== options.runId &&
          artifact.metadata?.labels?.manifestId === options.manifestId
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const candidate of candidates) {
      try {
        const artifact = await options.store.loadArtifact(
          'eval-run-summary',
          candidate.id
        );
        if (isComparable(artifact.data, options.manifestId, options.arms))
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
      if (isComparable(value, options.manifestId, options.arms))
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
  arm: { metrics?: Record<string, unknown> },
  key: string
): number | undefined {
  const value = arm.metrics?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Case IDs, once each (a case ID may repeat across an arm's datasets). */
function ids(cases: Array<{ id: string }>): string[] {
  return [...new Set(cases.map((c) => c.id))];
}

/** This run against a previous one, arm by arm. */
export function compareWithPrevious(
  previous: PreviousRun,
  current: EvaluationSummary
): PreviousRunComparison {
  const before = new Map(previous.summary.arms.map((arm) => [arm.name, arm]));
  const arms: Record<string, PreviousRunArm> = {};
  for (const arm of current.arms) {
    const prior = before.get(arm.name);
    if (!prior?.result || !arm.result) continue;
    const comparison = compareEvalRuns({
      baseline: prior.result,
      candidate: arm.result,
    });
    const now = metric(arm, 'trial_pass_rate');
    const then = metric(prior, 'trial_pass_rate');
    arms[arm.name] = {
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
    sameManifest: previous.summary.contentHash === current.contentHash,
    passRate,
    passRateDelta: (metric(current, 'passRate') ?? 0) - passRate,
    arms,
  };
}
