/**
 * Pairwise comparison of two runs, case by case.
 *
 * Given a baseline run and a candidate run of the same cases, calls each
 * pairwise judge on every case both runs have, and aggregates a win rate.
 * Runs come from anywhere: two variants of one eval, a run and a stored
 * baseline, or two runs made on separate machines.
 */

import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../judge/judgeTypes.js';
import type { JudgeCase, JudgeCaseSource } from '../judge/judgeContract.js';
import {
  buildJudgeCase,
  buildJudgeTrial,
  missingRequirement,
  sumJudgeUsage,
} from '../judge/judgeContract.js';
import type {
  PairwiseDimension,
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PreferredSide,
  PairwisePreference,
} from '../judge/pairwiseContract.js';
import { judgeIdentity, judgeIsVersioned } from '../judge/judgeIdentity.js';
import { extensionLookup } from '../plugins/extensions.js';
import {
  parseExtensionOptions,
  type SettingsContext,
} from '../plugins/plugin.js';
import { settingsFor, type SettingsSections } from '../plugins/settings.js';

const pairwiseJudges = extensionLookup('pairwiseJudges', () => ({}));

/** The pairwise judge `reference` names: `<namespace>/pairwise-judge/<name>` from a plugin. */
export function getPairwiseJudge(reference: string): PairwiseJudgeDefinition {
  return pairwiseJudges.get(reference);
}

/** Installed plugins' pairwise judges, by reference, sorted. */
export function listPairwiseJudges(): Array<[string, PairwiseJudgeDefinition]> {
  return pairwiseJudges.list();
}

/**
 * Checks that each pairwise judge can run (`PairwiseJudgeDefinition.preflight`),
 * once per judge and options, before anything is collected.
 */
export async function preflightPairwiseJudges(
  specs: readonly PairwiseJudgeSpec[],
  settings?: SettingsSections
): Promise<void> {
  const checked = new Set<string>();
  for (const spec of specs) {
    const key = JSON.stringify([spec.type, spec.options ?? {}]);
    if (checked.has(key)) continue;
    const judge = getPairwiseJudge(spec.type);
    if (judge.preflight)
      await judge.preflight(
        parseExtensionOptions(
          judge.schema,
          spec.options ?? {},
          `pairwise judge options "${spec.type}"`
        ),
        { settings: settingsFor(settings, spec.type) }
      );
    checked.add(key);
  }
}

/** One pairwise judge to run, as an eval config lists it. */
export interface PairwiseJudgeSpec {
  type: string;
  options?: Record<string, unknown>;
  /** Judge calls per case, per order. Majority preference wins. @default 1 */
  reps?: number;
}

export interface ComparePairwiseOptions {
  baseline: { name?: string; caseResults: readonly EvalCaseResult[] };
  candidate: { name?: string; caseResults: readonly EvalCaseResult[] };
  judges: readonly PairwiseJudgeSpec[];
  /**
   * The dataset cases, by id, for ground truth the results don't carry
   * (`expected`, metadata). Optional: without it a case is
   * built from the result's request.
   */
  cases?: ReadonlyMap<string, JudgeCaseSource>;
  /** Cases compared at once. @default 4 */
  concurrency?: number;
  /** The eval's plugin settings; each judge gets its plugin's (ADR 0008). */
  settings?: SettingsSections;
  /**
   * Where each case is compared: called with the case's id, the pairwise
   * judges' names (one preference each, in order), and `judge`, which runs
   * every pairwise judge on it here, or only those `only` names. Without it,
   * every case is compared here. `mst grade --env` (ADR 0005) records what
   * workers' judges preferred, and reads those records back on the
   * coordinator; `mst grade --resume` runs only judges without a preference.
   */
  judgeCase?: (
    caseId: string,
    judges: readonly string[],
    judge: (only?: readonly string[]) => Promise<PairwiseCasePreference[]>
  ) => Promise<PairwiseCasePreference[]>;
}

/** One judge's comparison of one case. */
export interface PairwiseCasePreference {
  judge: string;
  preference?: PreferredSide;
  /** Mean strength toward the preferred side, 0 to 1. */
  strength?: number;
  skipped?: boolean;
  error?: string;
  reasoning?: string;
  /** Whether the swapped-order preference agreed, when the judge ran both orders. */
  consistent?: boolean;
  dimensions?: Record<string, PairwiseDimension>;
  usage?: Partial<UsageMetrics>;
  provider?: string;
  model?: string;
  version?: string;
  /**
   * The identity of the judge that gave this preference (ADR 0009). A
   * preference kept from a run graded before MST recorded identities has
   * none.
   */
  judgeIdentity?: string;
  /** The judge has no version MST can see change. */
  judgeUnversioned?: true;
  metadata?: Record<string, unknown>;
}

export interface PairwiseCaseResult {
  id: string;
  preferences: PairwiseCasePreference[];
}

/** One judge's aggregate over all compared cases. */
export interface PairwiseJudgeSummary {
  judge: string;
  compared: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  skipped: number;
  errors: number;
  /** (wins + ties / 2) / compared, from the candidate's side. */
  candidateWinRate?: number;
  /** Share of cases whose two orders agreed, when the judge ran both. */
  consistency?: number;
  /** Per-dimension candidate win rate, over cases that reported the dimension. */
  dimensions?: Record<string, { compared: number; candidateWinRate: number }>;
  usage?: Partial<UsageMetrics>;
}

export interface PairwiseComparisonResult {
  baseline: string;
  candidate: string;
  /** Cases only one run has. They are not compared. */
  unmatched: { baselineOnly: string[]; candidateOnly: string[] };
  cases: PairwiseCaseResult[];
  summary: PairwiseJudgeSummary[];
  usage?: Partial<UsageMetrics>;
}

const flip: Record<PreferredSide, PreferredSide> = {
  baseline: 'candidate',
  candidate: 'baseline',
  tie: 'tie',
};

function caseSource(
  result: EvalCaseResult,
  source?: JudgeCaseSource
): JudgeCaseSource {
  if (source) return { id: result.id, ...source };
  const request = result.request;
  return {
    id: result.id,
    ...(request?.input !== undefined && { input: request.input }),
    ...(request?.reference !== undefined && {
      expected: { answer: request.reference },
    }),
    tags: result.tags ?? request?.tags ?? [],
  };
}

function trial(result: EvalCaseResult) {
  const judged = buildJudgeTrial(result.response, {
    clientResponse: result.response,
    ...(result.traceEvidence !== undefined && {
      evidence: result.traceEvidence,
    }),
  });
  // Stored responses drop the local path; the run keeps it in memory.
  return result.artifacts
    ? { ...judged, artifactsDir: result.artifacts.dir }
    : judged;
}

function checkPreference(value: unknown): PairwisePreference {
  const preference = value as PairwisePreference;
  if (typeof preference !== 'object' || preference === null)
    throw new Error('returned no preference');
  if (preference.skipped) return preference;
  if (!['baseline', 'candidate', 'tie'].includes(preference.preference))
    throw new Error(`returned preference ${String(preference.preference)}`);
  if (
    preference.strength !== undefined &&
    !(
      Number.isFinite(preference.strength) &&
      preference.strength >= 0 &&
      preference.strength <= 1
    )
  )
    throw new Error(
      `returned strength ${String(preference.strength)}, not between 0 and 1`
    );
  return preference;
}

// Majority preference across preferences; ties break to 'tie'.
function majority(preferences: readonly PairwisePreference[]): PreferredSide {
  const count = { baseline: 0, candidate: 0, tie: 0 };
  for (const v of preferences) count[v.preference] += 1;
  if (count.candidate > count.baseline && count.candidate >= count.tie)
    return 'candidate';
  if (count.baseline > count.candidate && count.baseline >= count.tie)
    return 'baseline';
  return 'tie';
}

function mergeDimensions(
  preferences: readonly PairwisePreference[]
): Record<string, PairwiseDimension> | undefined {
  const names = new Set(
    preferences.flatMap((v) => Object.keys(v.dimensions ?? {}))
  );
  if (names.size === 0) return undefined;
  const out: Record<string, PairwiseDimension> = {};
  for (const name of names) {
    const all = preferences.flatMap((v) =>
      v.dimensions?.[name] ? [v.dimensions[name]] : []
    );
    const preference = majority(all as PairwisePreference[]);
    const first = all.find((d) => d.preference === preference) ?? all[0]!;
    out[name] = { ...first, preference };
  }
  return out;
}

async function judgeCase(
  label: string,
  judge: PairwiseJudgeDefinition,
  options: Record<string, unknown>,
  reps: number,
  input: PairwiseJudgeInput,
  context: SettingsContext
): Promise<PairwiseCasePreference> {
  const missing = missingRequirement(input, judge.requires);
  if (missing !== undefined)
    return { judge: label, skipped: true, reasoning: `no ${missing}` };
  const swapped: PairwiseJudgeInput = {
    case: input.case,
    baseline: input.candidate,
    candidate: input.baseline,
  };
  const both = judge.swapPositions !== false;
  const forward: PairwisePreference[] = [];
  const reverse: PairwisePreference[] = [];
  try {
    for (let i = 0; i < reps; i++) {
      forward.push(
        checkPreference(await judge.compare(input, options, context))
      );
      if (forward.at(-1)!.skipped) break;
      if (both) {
        const r = checkPreference(
          await judge.compare(swapped, options, context)
        );
        // Report the swapped preference from the original orientation.
        reverse.push({
          ...r,
          preference: flip[r.preference] ?? r.preference,
          ...(r.dimensions && {
            dimensions: Object.fromEntries(
              Object.entries(r.dimensions).map(([k, d]) => [
                k,
                {
                  ...d,
                  preference: flip[d.preference],
                  baseline: d.candidate,
                  candidate: d.baseline,
                },
              ])
            ),
          }),
        });
        if (reverse.at(-1)!.skipped) break;
      }
    }
  } catch (err) {
    return {
      judge: label,
      error: err instanceof Error ? err.message : String(err),
      ...(forward.length + reverse.length > 0 && {
        usage: sumJudgeUsage([...forward, ...reverse].map((v) => v.usage)),
      }),
    };
  }
  const all = [...forward, ...reverse];
  const usage = sumJudgeUsage(all.map((v) => v.usage));
  const skipped = all.find((v) => v.skipped);
  if (skipped)
    return {
      judge: label,
      skipped: true,
      ...(skipped.reasoning && { reasoning: skipped.reasoning }),
      ...(usage && { usage }),
    };
  const preference = majority(all);
  const toward = all.filter(
    (v) => v.preference === preference && v.strength !== undefined
  );
  const last = all.at(-1)!;
  const dimensions = mergeDimensions(all);
  return {
    judge: label,
    preference,
    ...(toward.length > 0 && {
      strength: toward.reduce((sum, v) => sum + v.strength!, 0) / toward.length,
    }),
    ...(both && { consistent: majority(forward) === majority(reverse) }),
    ...((all.find((v) => v.preference === preference) ?? last).reasoning !==
      undefined && {
      reasoning: (all.find((v) => v.preference === preference) ?? last)
        .reasoning,
    }),
    ...(dimensions && { dimensions }),
    ...(usage && { usage }),
    ...(last.provider && { provider: last.provider }),
    ...(last.model && { model: last.model }),
    ...(last.version && { version: last.version }),
    ...(last.metadata && { metadata: last.metadata }),
  };
}

function summarize(
  judge: string,
  preferences: readonly PairwiseCasePreference[]
): PairwiseJudgeSummary {
  const decided = preferences.filter((v) => v.preference !== undefined);
  const wins = decided.filter((v) => v.preference === 'candidate').length;
  const losses = decided.filter((v) => v.preference === 'baseline').length;
  const ties = decided.filter((v) => v.preference === 'tie').length;
  const checked = decided.filter((v) => v.consistent !== undefined);
  const dims = new Map<string, { n: number; points: number }>();
  for (const v of decided)
    for (const [name, d] of Object.entries(v.dimensions ?? {})) {
      const entry = dims.get(name) ?? { n: 0, points: 0 };
      entry.n += 1;
      entry.points +=
        d.preference === 'candidate' ? 1 : d.preference === 'tie' ? 0.5 : 0;
      dims.set(name, entry);
    }
  const usage = sumJudgeUsage(preferences.map((v) => v.usage));
  return {
    judge,
    compared: decided.length,
    candidateWins: wins,
    baselineWins: losses,
    ties,
    skipped: preferences.filter((v) => v.skipped).length,
    errors: preferences.filter((v) => v.error !== undefined).length,
    ...(decided.length > 0 && {
      candidateWinRate: (wins + ties / 2) / decided.length,
    }),
    ...(checked.length > 0 && {
      consistency: checked.filter((v) => v.consistent).length / checked.length,
    }),
    ...(dims.size > 0 && {
      dimensions: Object.fromEntries(
        [...dims].map(([name, { n, points }]) => [
          name,
          { compared: n, candidateWinRate: points / n },
        ])
      ),
    }),
    ...(usage && { usage }),
  };
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, items.length)) },
      async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]!);
        }
      }
    )
  );
  return out;
}

/**
 * Compare two runs case by case with pairwise judges.
 *
 * Cases are matched by id. A case one run lacks is listed in `unmatched` and
 * not compared. Each judge runs each case in both orders unless it opts out
 * (`swapPositions: false`), and reports whether the orders agreed. A judge
 * that throws records an error for that case, not a preference.
 */
export async function comparePairwise(
  options: ComparePairwiseOptions
): Promise<PairwiseComparisonResult> {
  const resolved = options.judges.map((spec) => {
    const judge = getPairwiseJudge(spec.type);
    const reps = Math.max(1, spec.reps ?? 1);
    return {
      label: spec.type,
      judge,
      options: parseExtensionOptions(
        judge.schema,
        spec.options ?? {},
        `pairwise judge options "${spec.type}"`
      ),
      reps,
      context: { settings: settingsFor(options.settings, spec.type) },
      identity: {
        judgeIdentity: judgeIdentity(spec.type, judge, spec.options ?? {}, {
          reps,
        }),
        ...(judgeIsVersioned(spec.type, judge)
          ? {}
          : { judgeUnversioned: true as const }),
      },
    };
  });
  const baseline = new Map(options.baseline.caseResults.map((r) => [r.id, r]));
  const candidate = new Map(
    options.candidate.caseResults.map((r) => [r.id, r])
  );
  const ids = [...baseline.keys()].filter((id) => candidate.has(id));
  const cases = await mapLimited(ids, options.concurrency ?? 4, async (id) => {
    const b = baseline.get(id)!;
    const c = candidate.get(id)!;
    const judgeCase0: JudgeCase = buildJudgeCase(
      caseSource(b, options.cases?.get(id))
    );
    const input: PairwiseJudgeInput = {
      case: judgeCase0,
      baseline: trial(b),
      candidate: trial(c),
    };
    const judge = async (only?: readonly string[]) => {
      const preferences: PairwiseCasePreference[] = [];
      for (const r of resolved)
        if (!only || only.includes(r.label))
          preferences.push({
            ...(await judgeCase(
              r.label,
              r.judge,
              r.options,
              r.reps,
              input,
              r.context
            )),
            ...r.identity,
          });
      return preferences;
    };
    const preferences = options.judgeCase
      ? await options.judgeCase(
          id,
          resolved.map((r) => r.label),
          judge
        )
      : await judge();
    return { id, preferences };
  });
  const summary = resolved.map((r) =>
    summarize(
      r.label,
      cases.map((c) => c.preferences.find((v) => v.judge === r.label)!)
    )
  );
  const usage = sumJudgeUsage(summary.map((s) => s.usage));
  return {
    baseline: options.baseline.name ?? 'baseline',
    candidate: options.candidate.name ?? 'candidate',
    unmatched: {
      baselineOnly: [...baseline.keys()].filter((id) => !candidate.has(id)),
      candidateOnly: [...candidate.keys()].filter((id) => !baseline.has(id)),
    },
    cases,
    summary,
    ...(usage && { usage }),
  };
}
