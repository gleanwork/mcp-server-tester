import { useMemo, useState } from 'react';
import type { HistoryIndex, HistoryRun } from '../../types';
import { TONE, pts } from '../Comparison/format';
import { TrendChart } from './TrendChart';
import {
  breaksBetween,
  caseChanges,
  completeFor,
  dateText,
  eraStarts,
  formatValue,
  isPoint,
  metricsOf,
  reportHref,
  shortId,
  variantColors,
  variantNames,
} from './historyData';

/**
 * An eval's history: each metric over its runs, a line per variant, where
 * eras start and why; the runs, newest first; and the cases whose verdict
 * changed between two runs.
 */
export function HistoryPage({ data }: { data: HistoryIndex }) {
  const names = useMemo(() => variantNames(data), [data]);
  const colors = useMemo(() => variantColors(names), [names]);
  const points = useMemo(() => data.runs.filter(isPoint).reverse(), [data]);
  const eras = useMemo(() => eraStarts(points), [points]);
  const metrics = useMemo(() => metricsOf(data), [data]);
  const [hidden, setHidden] = useState<string[]>([]);
  const shown = names.filter((name) => !hidden.includes(name));
  const baseline = points[points.length - 1]?.baseline;
  const latest = points[points.length - 1];

  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-4 py-8 sm:px-6">
      <header className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.evalName}
          </h1>
          {latest && (
            <a
              href={reportHref(latest)}
              className="text-sm text-primary underline-offset-2 hover:underline"
            >
              Latest run&apos;s report
            </a>
          )}
        </div>
        <p className="text-[15px] text-muted-foreground">
          History:{' '}
          {points.length
            ? `${points.length} ${points.length === 1 ? 'run' : 'runs'}, ${dateText(points[0]!.collectedAt)} to ${dateText(latest!.collectedAt)}`
            : 'no full runs yet'}{' '}
          · {eras.length + 1} {eras.length ? 'eras' : 'era'} · {names.length}{' '}
          {names.length === 1 ? 'variant' : 'variants'}
          {data.runs.length > points.length && (
            <>
              {' '}
              · {data.runs.length - points.length} more{' '}
              {data.runs.length - points.length === 1 ? 'run' : 'runs'} not on
              the lines (partial, ungraded, failed or regraded)
            </>
          )}
        </p>
      </header>

      <section
        aria-labelledby="history-variants-h"
        className="grid min-w-0 gap-3"
      >
        <h2
          id="history-variants-h"
          className="text-sm font-semibold text-muted-foreground"
        >
          Variants
        </h2>
        <div className="flex flex-wrap gap-2">
          {names.map((name) => {
            const off = hidden.includes(name);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden(
                    off ? hidden.filter((n) => n !== name) : [...hidden, name]
                  )
                }
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-sm transition-colors ${off ? 'text-muted-foreground opacity-60' : 'bg-card'}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    background: off ? 'transparent' : colors[name],
                    border: `2px solid ${colors[name]}`,
                  }}
                />
                {name}
                {name === baseline && (
                  <span className="font-sans text-xs text-muted-foreground">
                    baseline
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          A hollow point is a run with incomplete cases for that variant; a red
          ring, a pass rate clearly worse than the previous comparable run.
          Lines break where a variant&apos;s era starts. Click a point to open
          its run&apos;s report.
        </p>
      </section>

      {points.length > 0 && (
        <section
          aria-labelledby="history-trends-h"
          className="grid min-w-0 gap-3"
        >
          <h2
            id="history-trends-h"
            className="text-sm font-semibold text-muted-foreground"
          >
            Over time
          </h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {metrics.map((metric) => (
              <TrendChart
                key={metric.id}
                metric={metric}
                points={points}
                variants={shown}
                colors={colors}
                eras={eras}
              />
            ))}
          </div>
        </section>
      )}

      {eras.length > 0 && <Eras eras={eras} points={points} />}

      <RunsTable data={data} names={shown} colors={colors} />

      {points.length > 1 && <ChangedCases points={points} names={shown} />}
    </div>
  );
}

function Eras({
  eras,
  points,
}: {
  eras: ReturnType<typeof eraStarts>;
  points: HistoryRun[];
}) {
  return (
    <section aria-labelledby="history-eras-h" className="grid min-w-0 gap-2">
      <h2
        id="history-eras-h"
        className="text-sm font-semibold text-muted-foreground"
      >
        Where eras start
      </h2>
      <p className="text-sm text-muted-foreground">
        Runs on either side of an era&apos;s start measured differently, so they
        aren&apos;t compared. Earlier runs stay on the page.
      </p>
      <ul className="grid gap-1 text-sm">
        {eras.map((era) => {
          const run = points.find((r) => r.runId === era.runId)!;
          return (
            <li key={era.runId}>
              <a
                href={reportHref(run)}
                className="font-mono text-primary underline-offset-2 hover:underline"
              >
                {shortId(run.runId)}
              </a>{' '}
              <span className="text-muted-foreground">
                ({dateText(run.collectedAt)})
              </span>
              :{' '}
              {era.reasons
                .map((r) =>
                  r.variant ? `${r.variant}: ${r.reason}` : r.reason
                )
                .join('; ')}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Status words for a run that isn't a plain point. */
function runBadges(
  run: HistoryRun
): Array<{ label: string; tone: keyof typeof TONE; title?: string }> {
  const badges: Array<{
    label: string;
    tone: keyof typeof TONE;
    title?: string;
  }> = [];
  if (run.partial)
    badges.push({
      label: 'partial',
      tone: 'warn',
      title: `Narrowed at run time: ${JSON.stringify(run.selection ?? {})}. Never compared with full runs.`,
    });
  if (run.status === 'ungraded')
    badges.push({ label: 'ungraded', tone: 'neutral' });
  if (run.status === 'failed')
    badges.push({ label: 'stopped early', tone: 'bad' });
  if (run.supersededBy)
    badges.push({
      label: `regraded as ${shortId(run.supersededBy)}`,
      tone: 'neutral',
    });
  if (run.gradedFrom) badges.push({ label: 'regrade', tone: 'neutral' });
  return badges;
}

function RunsTable({
  data,
  names,
  colors,
}: {
  data: HistoryIndex;
  names: string[];
  colors: Record<string, string>;
}) {
  return (
    <section aria-labelledby="history-runs-h" className="grid min-w-0 gap-2">
      <h2
        id="history-runs-h"
        className="text-sm font-semibold text-muted-foreground"
      >
        Runs, newest first
      </h2>
      <div className="overflow-x-auto rounded-lg border scrollbar-thin">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Run</th>
              <th className="px-3 py-2 font-medium">Collected</th>
              {names.map((name) => (
                <th key={name} className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: colors[name] }}
                    />
                    {name}
                  </span>
                </th>
              ))}
              <th className="min-w-[16rem] px-3 py-2 font-medium">
                What changed
              </th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr
                key={run.runId}
                className={`border-t align-top ${isPoint(run) ? '' : 'text-muted-foreground'}`}
              >
                <td className="px-3 py-2">
                  <a
                    href={reportHref(run)}
                    title={run.runId}
                    className="font-mono text-primary underline-offset-2 hover:underline"
                  >
                    {shortId(run.runId)}
                  </a>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {runBadges(run).map((badge) => (
                      <span
                        key={badge.label}
                        title={badge.title}
                        className={`rounded-full px-1.5 py-px text-[11px] font-semibold ${TONE[badge.tone]}`}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {dateText(run.collectedAt, true)}
                </td>
                {names.map((name) => {
                  const variant = run.variants.find((v) => v.name === name);
                  if (!variant)
                    return (
                      <td
                        key={name}
                        className="px-3 py-2 text-muted-foreground"
                      >
                        —
                      </td>
                    );
                  const since = variant.sincePrevious;
                  const change = since?.change;
                  const tone =
                    change?.assessment === 'better'
                      ? 'text-green-700 dark:text-green-400'
                      : change?.assessment === 'worse'
                        ? 'text-red-700 dark:text-red-400'
                        : 'text-muted-foreground';
                  return (
                    <td key={name} className="px-3 py-2">
                      <div className="font-semibold tabular-nums">
                        {variant.headline
                          ? formatValue(variant.headline.passRate, 'pct')
                          : '—'}
                        {!completeFor(run, variant) && isPoint(run) && (
                          <span
                            className="ml-1 font-normal text-amber-700 dark:text-amber-300"
                            title={`${variant.incomplete ?? 0} incomplete cases`}
                          >
                            ◌
                          </span>
                        )}
                      </div>
                      {change && (
                        <div
                          className={`text-xs ${tone}`}
                          title={`Since ${shortId(since.runId)}, paired over ${change.cases} cases: 95% range ${pts(change.lower)} to ${pts(change.upper)} pts`}
                        >
                          {change.assessment === 'better'
                            ? '▲'
                            : change.assessment === 'worse'
                              ? '▼'
                              : ''}{' '}
                          {pts(change.mean)} pts
                        </div>
                      )}
                      {since?.regressed && (
                        <span
                          className={`mt-0.5 inline-block rounded-full px-1.5 py-px text-[11px] font-semibold ${TONE.bad}`}
                        >
                          regressed
                        </span>
                      )}
                      {variant.costUsd !== undefined && (
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatValue(variant.costUsd, 'usd')}/trial
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {(run.changes ?? [])
                    .map((c) =>
                      c.variant ? `${c.variant}: ${c.reason}` : c.reason
                    )
                    .join('; ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        The pass rate is the headline cases&apos; (capability cases, or
        regression cases when every case is one). Its change is the paired test
        the run report uses, against the previous run of the variant&apos;s era
        that was complete for it.
      </p>
    </section>
  );
}

function ChangedCases({
  points,
  names,
}: {
  points: HistoryRun[];
  names: string[];
}) {
  const latest = points[points.length - 1]!;
  const reference =
    latest.variants.find((v) => v.sincePrevious)?.sincePrevious?.runId ??
    points[points.length - 2]!.runId;
  const [toId, setToId] = useState(latest.runId);
  const [fromId, setFromId] = useState(reference);
  const to = points.find((run) => run.runId === toId) ?? latest;
  const from = points.find((run) => run.runId === fromId) ?? points[0]!;
  const changes = caseChanges(from, to).filter((c) =>
    names.includes(c.variant)
  );
  const breaks = breaksBetween(points, from, to);
  const select = (
    value: string,
    onChange: (id: string) => void,
    label: string
  ) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border bg-card px-2 py-1 font-mono text-sm text-foreground"
      >
        {[...points].reverse().map((run) => (
          <option key={run.runId} value={run.runId}>
            {shortId(run.runId)} · {dateText(run.collectedAt)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section aria-labelledby="history-cases-h" className="grid min-w-0 gap-3">
      <h2
        id="history-cases-h"
        className="text-sm font-semibold text-muted-foreground"
      >
        Cases that changed
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        {select(fromId, setFromId, 'From')}
        <span className="pb-1.5 text-muted-foreground">→</span>
        {select(toId, setToId, 'To')}
      </div>
      {breaks.length > 0 && (
        <p className={`rounded px-3 py-2 text-sm ${TONE.warn}`}>
          These runs are in different eras ({breaks.join('; ')}): a verdict may
          have changed because of that, not the variant.
        </p>
      )}
      {from.runId === to.runId ? (
        <p className="text-sm text-muted-foreground">Pick two runs.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {changes.map((c) => (
            <div
              key={c.variant}
              className="grid gap-2 rounded-lg border bg-card p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-semibold">
                  {c.variant}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.nowFailing.length} now failing · {c.nowPassing.length} now
                  passing · {c.same} the same
                  {c.added ? ` · ${c.added} new` : ''}
                  {c.removed ? ` · ${c.removed} gone` : ''}
                </span>
              </div>
              {c.nowFailing.length + c.nowPassing.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No case changed its verdict.
                </p>
              ) : (
                <ul className="grid gap-0.5 text-sm">
                  {[
                    ...c.nowFailing.map((row) => ({ ...row, failing: true })),
                    ...c.nowPassing.map((row) => ({ ...row, failing: false })),
                  ].map((row) => (
                    <li key={row.id} className="flex items-baseline gap-2">
                      <span
                        className={
                          row.failing
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-green-700 dark:text-green-400'
                        }
                        aria-label={row.failing ? 'now failing' : 'now passing'}
                      >
                        {row.failing ? '▼' : '▲'}
                      </span>
                      <span className="break-all font-mono">{row.id}</span>
                      <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {row.before[0]}/{row.before[1]} → {row.after[0]}/
                        {row.after[1]} trials
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
