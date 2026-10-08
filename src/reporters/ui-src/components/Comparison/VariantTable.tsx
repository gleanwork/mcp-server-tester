import { useState } from 'react';
import type {
  MCPComparisonData,
  MCPRunReportData,
  PairedChange,
  RunReportVariant,
  VariantComparisonEntry,
} from '../../types';
import {
  STATUS_LABEL,
  STATUS_TONE,
  TONE,
  betterThreshold,
  direction,
  heldOutUnconfirmed,
  pValue,
  pct,
  pts,
  rangeText,
  variantName,
} from './format';

interface VariantTableProps {
  data: MCPComparisonData;
  selectedId: string;
  onSelect: (id: string) => void;
  /** An eval run's report: adds its judge, pairwise, cost, time and tool columns. */
  report?: MCPRunReportData;
}

export const VERDICT_LABEL: Record<RunReportVariant['verdict'], string> = {
  baseline: 'Baseline',
  better: 'Clearly better',
  worse: 'Clearly worse',
  unclear: 'No clear change',
};

export const VERDICT_TONE: Record<
  RunReportVariant['verdict'],
  keyof typeof TONE
> = {
  baseline: 'neutral',
  better: 'good',
  worse: 'bad',
  unclear: 'neutral',
};

/** "aggregated 100% · native 4%": the top tools (or servers) by share of calls. */
function toolsText(tools: RunReportVariant['toolsUsed']): string {
  if (tools.length === 0) return 'no tool calls';
  const top = tools.slice(0, 3).map((t) => `${t.name} ${pct(t.share)}`);
  return tools.length > 3 ? `${top.join(' · ')} · …` : top.join(' · ');
}

/** A pairwise judge's verdict: "32% win · 61% loss". */
function pairwiseText(judge: RunReportVariant['pairwise'][number]): string {
  const n = judge.compared;
  if (n === 0) return 'not compared';
  return `${pct(judge.wins / n)} win · ${pct(judge.losses / n)} loss`;
}

/** A change from the baseline as a colored pill: green, red, or grey for noise. */
function ChangePill({ change }: { change: PairedChange }) {
  const dir = direction(change);
  const text =
    Math.abs(change.mean) < 0.0005
      ? 'no change'
      : dir === 'flat'
        ? `${pts(change.mean)} · noise`
        : pts(change.mean);
  const tone =
    dir === 'up' ? TONE.good : dir === 'down' ? TONE.bad : TONE.neutral;
  const call =
    dir === 'up'
      ? 'clearly better'
      : dir === 'down'
        ? 'clearly worse'
        : 'not clear either way';
  return (
    <span
      title={`Change vs current: ${call}. 95% range ${rangeText(change)}.`}
      className={`inline-block whitespace-nowrap rounded-full px-2 py-px font-mono text-xs font-semibold ${tone}`}
    >
      {text}
    </span>
  );
}

/** A point estimate and its 95% range, drawn against zero, with its p-value. */
function RangePlot({
  change,
  domain,
  p,
}: {
  change: PairedChange;
  domain: [number, number];
  /** The p-value behind the assessment that matters for this column. */
  p: number;
}) {
  const [lo, hi] = domain;
  const pos = (x: number) => ((x - lo) / (hi - lo)) * 100;
  const dir = direction(change);
  const color =
    dir === 'up'
      ? 'bg-green-600 dark:bg-green-400'
      : dir === 'down'
        ? 'bg-red-600 dark:bg-red-400'
        : 'bg-muted-foreground/60';
  return (
    <div
      className="grid min-w-[130px] gap-0.5"
      role="img"
      aria-label={`${pts(change.mean)} points, 95% range ${rangeText(change)}`}
    >
      <div className="relative h-4">
        <span
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: `${pos(0)}%` }}
        />
        <span
          className={`absolute top-[7px] h-0.5 rounded ${color}`}
          style={{
            left: `${pos(change.lower)}%`,
            width: `${Math.max(0.6, pos(change.upper) - pos(change.lower))}%`,
          }}
        />
        <span
          className={`absolute top-[3px] -ml-[5px] h-2.5 w-2.5 rounded-full ${color}`}
          style={{ left: `${pos(change.mean)}%` }}
        />
      </div>
      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
        <b className="font-semibold text-foreground">{pts(change.mean)}</b> [
        {pts(change.lower)}, {pts(change.upper)}] · {pValue(p)}
      </span>
    </div>
  );
}

function domainOf(
  variants: VariantComparisonEntry[],
  pick: (v: VariantComparisonEntry) => PairedChange | undefined
): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const v of variants) {
    const c = pick(v);
    if (!c) continue;
    lo = Math.min(lo, c.lower);
    hi = Math.max(hi, c.upper);
  }
  const pad = (hi - lo) * 0.06 || 0.05;
  return [lo - pad, hi + pad];
}

function Rate({
  rate,
  change,
  showChange,
}: {
  rate: number | undefined;
  change: PairedChange | undefined;
  showChange: boolean;
}) {
  if (rate === undefined)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-baseline justify-end gap-2">
      {showChange && change ? <ChangePill change={change} /> : null}
      <b className="font-mono tabular-nums">{pct(rate)}</b>
    </span>
  );
}

export function VariantTable({
  data,
  selectedId,
  onSelect,
  report,
}: VariantTableProps) {
  const [showStats, setShowStats] = useState(false);
  const isEval = data.purpose === 'eval';
  const rowOf = (id: string) => report?.variants.find((v) => v.id === id);
  const rows = report?.variants ?? [];
  const showRegression =
    !isEval || data.cases.some((c) => c.group === 'regression');
  const showJudge = rows.some((v) => v.judgeScores.length > 0);
  const judgeCount = new Set(
    rows.flatMap((v) => v.judgeScores.map((s) => s.judge))
  ).size;
  const showPairwise = rows.some((v) => v.pairwise.length > 0);
  const showCost = rows.some((v) => v.costPerCase !== undefined);
  const showTime = rows.some((v) => v.medianDurationMs !== undefined);
  const candidates = data.variants.filter((v) => v.id !== data.baselineId);
  const swDomain = domainOf(candidates, (v) => v.capability.change);
  const kwDomain = domainOf(candidates, (v) => v.regression.change);
  const k = data.trialsPerCase;

  const th = 'px-3 py-2 text-left align-bottom font-semibold';
  const thNum = `${th} text-right`;
  const td = 'px-3 py-2 align-middle';
  const tdNum = `${td} text-right`;

  return (
    <section aria-labelledby="exp-variants-h" className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="exp-variants-h" className="text-lg font-semibold">
          {isEval ? 'Variants compared' : 'All variants compared'}
        </h2>
        <button
          type="button"
          aria-pressed={showStats}
          onClick={() => setShowStats((s) => !s)}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {showStats ? 'Hide statistics' : 'Show statistics'}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Select a row to show that variant in the sections below.
      </p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className={th}>
                Variant
              </th>
              <th scope="col" className={thNum}>
                {isEval
                  ? showRegression
                    ? 'Other cases'
                    : 'Pass rate'
                  : 'Capability cases'}
              </th>
              {showRegression && (
                <th scope="col" className={thNum}>
                  Regression cases
                </th>
              )}
              {showStats && (
                <>
                  <th scope="col" className={th}>
                    {isEval ? 'Pass rate' : 'Capability cases'}: change, 95%
                    range
                  </th>
                  <th scope="col" className={thNum}>
                    Seen → held out
                  </th>
                  <th scope="col" className={thNum}>
                    Every trial passed (pass^{k})
                  </th>
                  {showRegression && (
                    <th scope="col" className={th}>
                      Regression cases: change, 95% range
                    </th>
                  )}
                  <th scope="col" className={thNum}>
                    Cases ▲ / ▼
                  </th>
                </>
              )}
              {showJudge && (
                <th scope="col" className={thNum}>
                  Judge
                </th>
              )}
              {showPairwise && (
                <th scope="col" className={th}>
                  vs baseline (pairwise)
                </th>
              )}
              {showCost && (
                <th scope="col" className={thNum}>
                  $/case
                </th>
              )}
              {showTime && (
                <th scope="col" className={thNum}>
                  Median
                </th>
              )}
              {report && (
                <th scope="col" className={th}>
                  Tools used
                </th>
              )}
              <th scope="col" className={thNum}>
                {report ? 'Tokens per trial' : 'Cost per trial'}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.variants.map((v) => {
              const isBase = v.id === data.baselineId;
              const selected = v.id === selectedId;
              const row = rowOf(v.id);
              const name = (
                <span className="grid gap-0.5">
                  <span className="whitespace-nowrap font-mono font-semibold">
                    {variantName(data, v)}
                  </span>
                  {row ? (
                    <span
                      className={`w-fit whitespace-nowrap rounded-full px-2 py-px text-xs font-semibold ${TONE[VERDICT_TONE[row.verdict]]}`}
                    >
                      {VERDICT_LABEL[row.verdict]}
                    </span>
                  ) : (
                    <span
                      className={`w-fit whitespace-nowrap rounded-full px-2 py-px text-xs font-semibold ${TONE[STATUS_TONE[v.status]]}`}
                    >
                      {STATUS_LABEL[v.status]}
                    </span>
                  )}
                </span>
              );
              const sw = v.capability;
              return (
                <tr
                  key={v.id}
                  className={`border-t ${selected ? 'bg-primary/5' : ''}`}
                >
                  <th scope="row" className={`${td} text-left font-normal`}>
                    {isBase ? (
                      name
                    ) : (
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelect(v.id)}
                        className={`-mx-2 -my-1 rounded-md border px-2 py-1 text-left ${
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-transparent hover:border-border'
                        }`}
                      >
                        {name}
                      </button>
                    )}
                  </th>
                  <td className={tdNum}>
                    <Rate
                      rate={sw.passRate}
                      change={sw.change}
                      showChange={!showStats}
                    />
                  </td>
                  {showRegression && (
                    <td className={tdNum}>
                      <Rate
                        rate={v.regression.passRate}
                        change={v.regression.change}
                        showChange={!showStats}
                      />
                    </td>
                  )}
                  {showStats && (
                    <>
                      <td className={td}>
                        {sw.change ? (
                          <RangePlot
                            change={sw.change}
                            domain={swDomain}
                            p={sw.change.pBetter}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            reference
                          </span>
                        )}
                      </td>
                      <td className={`${tdNum} whitespace-nowrap font-mono`}>
                        {sw.seenPassRate !== undefined &&
                        sw.heldOutPassRate !== undefined ? (
                          <>
                            {pct(sw.seenPassRate)} → {pct(sw.heldOutPassRate)}
                            {!isBase && heldOutUnconfirmed(v) && (
                              <span
                                title="Clearly better overall, but not on held-out cases, which ranking never used"
                                className={`ml-2 rounded-full px-2 py-px font-sans text-xs font-semibold ${TONE.warn}`}
                              >
                                not confirmed
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={`${tdNum} font-mono`}>
                        {sw.allTrialsPassedRate !== undefined
                          ? pct(sw.allTrialsPassedRate)
                          : '—'}
                      </td>
                      {showRegression && (
                        <td className={td}>
                          {v.regression.change ? (
                            <RangePlot
                              change={v.regression.change}
                              domain={kwDomain}
                              p={v.regression.change.pWorse}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              reference
                            </span>
                          )}
                        </td>
                      )}
                      <td className={`${tdNum} whitespace-nowrap`}>
                        {isBase ? (
                          <span className="text-xs text-muted-foreground">
                            reference
                          </span>
                        ) : (
                          <CaseCounts
                            up={v.improvedCaseIds.length}
                            down={v.regressedCaseIds.length}
                          />
                        )}
                      </td>
                    </>
                  )}
                  {showJudge && (
                    <td className={`${tdNum} whitespace-nowrap font-mono`}>
                      {row && row.judgeScores.length > 0
                        ? row.judgeScores.map((s) => (
                            <span
                              key={s.judge}
                              className="block"
                              title={`${s.judge}: mean score`}
                            >
                              {judgeCount > 1 && (
                                <span className="text-xs text-muted-foreground">
                                  {s.judge.split('/').pop()}{' '}
                                </span>
                              )}
                              {Number(s.mean.toFixed(2))}
                            </span>
                          ))
                        : '—'}
                    </td>
                  )}
                  {showPairwise && (
                    <td className={`${td} whitespace-nowrap font-mono text-xs`}>
                      {isBase || !row || row.pairwise.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        row.pairwise.map((judge) => (
                          <span
                            key={judge.judge}
                            className="block"
                            title={`${judge.judge}: ${judge.wins} wins, ${judge.losses} losses, ${judge.ties} ties over ${judge.compared} cases${judge.errors ? `, ${judge.errors} errors` : ''}`}
                          >
                            {pairwiseText(judge)}
                          </span>
                        ))
                      )}
                    </td>
                  )}
                  {showCost && (
                    <td className={`${tdNum} font-mono`}>
                      {row?.costPerCase !== undefined
                        ? row.costPerCase.toFixed(2)
                        : '—'}
                    </td>
                  )}
                  {showTime && (
                    <td className={`${tdNum} whitespace-nowrap font-mono`}>
                      {row?.medianDurationMs !== undefined
                        ? `${(row.medianDurationMs / 1000).toFixed(row.medianDurationMs < 10000 ? 1 : 0)} s`
                        : '—'}
                    </td>
                  )}
                  {report && (
                    <td
                      className={`${td} max-w-[260px] truncate font-mono text-xs`}
                      title={row ? toolsText(row.toolsUsed) : undefined}
                    >
                      {row ? toolsText(row.toolsUsed) : '—'}
                    </td>
                  )}
                  <td className={`${tdNum} whitespace-nowrap font-mono`}>
                    {v.meanTokensPerTrial !== undefined ? (
                      <span className="grid">
                        <span>
                          {(v.meanTokensPerTrial / 1000).toFixed(1)}k tokens
                        </span>
                        {showStats && v.meanToolCallsPerTrial !== undefined && (
                          <span className="text-muted-foreground">
                            {v.meanToolCallsPerTrial.toFixed(1)} tool calls
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="max-w-[100ch] text-xs text-muted-foreground">
        {showStats ? (
          <>
            Pass rate (pass@1) is the share of trials that passed. pass^{k} is
            the share of {isEval ? '' : 'should-now-work '}cases that passed all{' '}
            {k} trials. Each change is the mean per-case difference from the
            baseline, with a 95% t-interval over cases for scale. Colors and p
            come from an exact paired sign-flip test: clearly better needs p
            below {Number(betterThreshold(data).toPrecision(2))}
            {data.variantsTried > 1
              ? ` (${data.alpha} split across ${data.variantsTried} variants tried)`
              : ''}
            ; clearly worse needs p below {data.alpha}.
          </>
        ) : (
          <>
            Percent = share of trials that passed. Changes are compared with the
            baseline:{' '}
            <span className={`rounded-full px-1.5 ${TONE.good}`}>green</span> is
            clearly better,{' '}
            <span className={`rounded-full px-1.5 ${TONE.bad}`}>red</span> is
            clearly worse,{' '}
            <span className={`rounded-full px-1.5 ${TONE.neutral}`}>grey</span>{' '}
            is too small to tell from noise
            {data.variantsTried > 1
              ? `, allowing for ${data.variantsTried} variants tried`
              : ''}
            .
          </>
        )}
      </p>
    </section>
  );
}

/** Cases that got better and worse, as green and red pills. */
export function CaseCounts({ up, down }: { up: number; down: number }) {
  const pill =
    'inline-block whitespace-nowrap rounded-full px-2 py-px font-mono text-xs font-semibold';
  return (
    <span className="inline-flex gap-1">
      <span
        className={`${pill} ${up ? TONE.good : TONE.neutral}`}
        aria-label={`${up} better`}
      >
        ▲ {up}
      </span>
      <span
        className={`${pill} ${down ? TONE.bad : TONE.neutral}`}
        aria-label={`${down} worse`}
      >
        ▼ {down}
      </span>
    </span>
  );
}
