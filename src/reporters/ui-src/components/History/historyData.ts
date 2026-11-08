/**
 * What the history page plots, read from the eval's history
 * (`history.json`). Every number is computed by the library
 * (src/evals/runHistory.ts); these only pick and arrange them.
 */
import type { HistoryIndex, HistoryRun, HistoryVariant } from '../../types';

/** A run on the history's lines: a full run's shown grading that collected and graded. */
export function isPoint(run: HistoryRun): boolean {
  return (
    !run.partial &&
    run.supersededBy === undefined &&
    (run.status === 'complete' || run.status === 'incomplete')
  );
}

/** Whether the run is complete for the variant: it can be measured against. */
export function completeFor(run: HistoryRun, variant: HistoryVariant): boolean {
  return (
    run.phases.collect === 'complete' &&
    run.phases.grade === 'complete' &&
    !variant.incomplete &&
    (run.status === 'complete' || run.status === 'incomplete')
  );
}

/** A run's report, relative to the history page. */
export function reportHref(run: HistoryRun): string {
  return `../runs/${encodeURIComponent(run.runId)}/report/index.html`;
}

/** A run ID's short form: its last six characters, with any `.g<n>`. */
export function shortId(runId: string): string {
  return runId.slice(runId.lastIndexOf('-') + 1);
}

/** "Oct 26", or "Oct 26, 09:38" when two runs share a day. */
export function dateText(iso: string, withTime = false): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** Variant names in the order they first ran, the baseline first. */
export function variantNames(index: HistoryIndex): string[] {
  const names: string[] = [];
  const ordered = [...index.runs].reverse();
  const baseline = ordered.find((run) => !run.partial)?.baseline;
  if (baseline) names.push(baseline);
  for (const run of ordered)
    for (const variant of run.variants)
      if (!names.includes(variant.name)) names.push(variant.name);
  return names;
}

/** Each variant's colour: the baseline slate, the others categorical. */
export function variantColors(names: string[]): Record<string, string> {
  const palette = [
    '#3b82f6',
    '#f97316',
    '#8b5cf6',
    '#14b8a6',
    '#ec4899',
    '#eab308',
  ];
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      index === 0 ? '#94a3b8' : palette[(index - 1) % palette.length]!,
    ])
  );
}

export type MetricFormat = 'pct' | 'usd' | 'tokens' | 'seconds';

/** One chart: a value per variant per run, with an optional range. */
export interface MetricDef {
  id: string;
  title: string;
  /** What the value is, in a few words. */
  subtitle: string;
  format: MetricFormat;
  value(variant: HistoryVariant): number | undefined;
  /** A 95% range, drawn as a band. */
  band?(variant: HistoryVariant): [number, number] | undefined;
  /** A second value, drawn dashed (the 95th percentile, say). */
  secondary?(variant: HistoryVariant): number | undefined;
  /** Whether the chart marks regressed runs (the pass-rate chart). */
  marksRegressions?: boolean;
}

/** The charts the history has data for, in page order. */
export function metricsOf(index: HistoryIndex): MetricDef[] {
  // Only runs that are plotted: a chart of none of them would be empty.
  const variants = index.runs.filter(isPoint).flatMap((run) => run.variants);
  const judges = [...new Set(variants.flatMap((v) => Object.keys(v.judges)))];
  const pairwise = new Map<string, string>();
  for (const variant of variants)
    for (const [key, result] of Object.entries(variant.pairwise))
      pairwise.set(key, `${result.judge} vs ${result.reference.variant}`);
  const has = (value: (v: HistoryVariant) => number | undefined) =>
    variants.some((v) => value(v) !== undefined);
  const defs: MetricDef[] = [
    {
      id: 'pass-rate',
      title: 'Pass rate',
      subtitle:
        'Headline cases, mean share of trials passed, with the likely range',
      format: 'pct',
      value: (v) => v.headline?.passRate,
      band: (v) =>
        v.headline?.low !== undefined && v.headline.high !== undefined
          ? [v.headline.low, v.headline.high]
          : undefined,
      marksRegressions: true,
    },
    {
      id: 'case-pass-rate',
      title: 'Cases passed',
      subtitle: 'Share of cases that met their pass threshold',
      format: 'pct',
      value: (v) => v.casePassRate,
    },
    ...judges.map(
      (judge): MetricDef => ({
        id: `judge:${judge}`,
        title: `Judge: ${shortJudge(judge)}`,
        subtitle: 'Share of trials the judge passed (unknown answers left out)',
        format: 'pct',
        value: (v) => v.judges[judge]?.passRate,
      })
    ),
    ...[...pairwise].map(
      ([key, label]): MetricDef => ({
        id: `pairwise:${key}`,
        title: `Win rate: ${shortJudge(label)}`,
        subtitle:
          'Cases the pairwise judge preferred the variant in (a tie is half), with a 95% range',
        format: 'pct',
        value: (v) => v.pairwise[key]?.winRate,
        band: (v) => {
          const result = v.pairwise[key];
          return result?.low !== undefined && result.high !== undefined
            ? [result.low, result.high]
            : undefined;
        },
      })
    ),
    {
      id: 'cost',
      title: 'Cost per trial',
      subtitle: 'Mean USD per trial, each case weighted equally',
      format: 'usd',
      value: (v) => v.costUsd,
    },
    {
      id: 'tokens',
      title: 'Tokens per trial',
      subtitle: 'Mean input and output tokens per trial',
      format: 'tokens',
      value: (v) =>
        v.tokens &&
        (v.tokens.input !== undefined || v.tokens.output !== undefined)
          ? (v.tokens.input ?? 0) + (v.tokens.output ?? 0)
          : undefined,
    },
    {
      id: 'duration',
      title: 'Trial time',
      subtitle: 'Median wall time per trial; dashed, the 95th percentile',
      format: 'seconds',
      value: (v) => (v.durationMs ? v.durationMs.p50 / 1000 : undefined),
      secondary: (v) => (v.durationMs ? v.durationMs.p95 / 1000 : undefined),
    },
    {
      id: 'infra',
      title: 'Infrastructure failures',
      subtitle: 'Share of attempts lost to something around the client',
      format: 'pct',
      value: (v) =>
        v.attempts ? v.infrastructureFailures / v.attempts : undefined,
    },
  ];
  return defs.filter((def) => has(def.value));
}

/** A plugin judge's name without its namespace and kind. */
function shortJudge(name: string): string {
  return name.replace(/^[^/\s]+\/(judge|pairwise-judge)\//, '');
}

export function formatValue(value: number, format: MetricFormat): string {
  switch (format) {
    case 'pct':
      return `${trim(value * 100)}%`;
    case 'usd':
      return value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
    case 'tokens':
      return value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(Math.round(value));
    case 'seconds':
      return `${value.toFixed(1)} s`;
  }
}

function trim(x: number): string {
  return Math.abs(x - Math.round(x)) < 0.05
    ? String(Math.round(x))
    : x.toFixed(1);
}

/** Where an era starts, and why: the eval's breaks and each variant's own. */
export interface EraStart {
  runId: string;
  reasons: Array<{ reason: string; variant?: string }>;
}

/** Each point run that starts an era for some variant. */
export function eraStarts(points: HistoryRun[]): EraStart[] {
  return points.flatMap((run) => {
    const reasons = (run.changes ?? [])
      .filter((change) => change.breaks && change.reason !== 'variant added')
      .map(({ reason, variant }) => ({
        reason,
        ...(variant !== undefined ? { variant } : {}),
      }));
    return reasons.length ? [{ runId: run.runId, reasons }] : [];
  });
}

/** One variant's verdict changes between two runs. */
export interface CaseChanges {
  variant: string;
  nowFailing: Array<{
    id: string;
    before: [number, number];
    after: [number, number];
  }>;
  nowPassing: Array<{
    id: string;
    before: [number, number];
    after: [number, number];
  }>;
  added: number;
  removed: number;
  same: number;
}

/** The cases whose verdict changed between `from` and `to`, per variant both ran. */
export function caseChanges(from: HistoryRun, to: HistoryRun): CaseChanges[] {
  return to.variants.flatMap((variant) => {
    const before = from.variants.find((v) => v.name === variant.name);
    if (!before) return [];
    const changes: CaseChanges = {
      variant: variant.name,
      nowFailing: [],
      nowPassing: [],
      added: 0,
      removed: 0,
      same: 0,
    };
    for (const [id, now] of Object.entries(variant.outcomes)) {
      const then = before.outcomes[id];
      if (!then) {
        changes.added++;
        continue;
      }
      const row = {
        id,
        before: [then[0], then[1]] as [number, number],
        after: [now[0], now[1]] as [number, number],
      };
      if (then[2] === 1 && now[2] === 0) changes.nowFailing.push(row);
      else if (then[2] === 0 && now[2] === 1) changes.nowPassing.push(row);
      else changes.same++;
    }
    changes.removed = Object.keys(before.outcomes).filter(
      (id) => !(id in variant.outcomes)
    ).length;
    return [changes];
  });
}

/** Why two runs may not measure the same way: the era breaks between them. */
export function breaksBetween(
  points: HistoryRun[],
  from: HistoryRun,
  to: HistoryRun
): string[] {
  const [early, late] =
    from.collectedAt <= to.collectedAt ? [from, to] : [to, from];
  return points
    .filter(
      (run) =>
        run.collectedAt > early.collectedAt &&
        run.collectedAt <= late.collectedAt
    )
    .flatMap((run) =>
      (run.changes ?? [])
        .filter((change) => change.breaks && change.reason !== 'variant added')
        .map((change) =>
          change.variant ? `${change.variant}: ${change.reason}` : change.reason
        )
    );
}
