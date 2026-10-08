import { useState } from 'react';
import type { MCPRunReportData, RunReportVariant } from '../../types';
import {
  VariantTable,
  VERDICT_LABEL,
  VERDICT_TONE,
} from '../Comparison/VariantTable';
import { CaseGrid, type CaseFilter } from '../Comparison/CaseGrid';
import { TrialFailures } from '../Comparison/TrialFailures';
import { TONE, pct, pts } from '../Comparison/format';
import { SetupDiff } from './SetupDiff';
import { ComparisonView } from '../Comparison/ComparisonView';
import { TrialLookupContext } from './TrialDetail';

/** The headline rate for a variant: its share of passing trials. */
function rateOf(
  data: MCPRunReportData,
  variant: RunReportVariant
): number | undefined {
  const entry = data.comparison.variants.find((v) => v.id === variant.id);
  return variant.trialPassRate ?? entry?.capability.passRate;
}

const RATE_TONE: Record<RunReportVariant['verdict'], string> = {
  baseline: 'text-foreground',
  better: 'text-green-700 dark:text-green-400',
  worse: 'text-red-700 dark:text-red-400',
  unclear: 'text-foreground',
};

function trialsText(data: MCPRunReportData): string {
  const { min, max } = data.run.trialsPerCase;
  const n = (k: number) => `${k} ${k === 1 ? 'trial' : 'trials'}`;
  return min === max ? n(max) : `${min}–${max} trials`;
}

/** One sentence per variant: how it compares with the baseline. */
function VariantSentence({
  data,
  variant,
}: {
  data: MCPRunReportData;
  variant: RunReportVariant;
}) {
  const entry = data.comparison.variants.find((v) => v.id === variant.id);
  const baseline = data.variants.find((v) => v.baseline);
  const change = entry?.capability.change;
  const rate = rateOf(data, variant);
  const baseRate = baseline ? rateOf(data, baseline) : undefined;
  const worse = entry?.regressedCaseIds.length ?? 0;
  const better = entry?.improvedCaseIds.length ?? 0;
  return (
    <li>
      <span>
        <span className="font-mono font-semibold">{variant.name}</span>
        {rate !== undefined && baseRate !== undefined && (
          <>
            : {pct(rate)} of trials passed, against {pct(baseRate)} for{' '}
            <span className="font-mono">{baseline?.name}</span>
            {change ? ` (${pts(change.mean)} pts)` : ''}.
          </>
        )}{' '}
        <span className="text-muted-foreground">
          {worse} {worse === 1 ? 'case' : 'cases'} worse, {better} better.
          {variant.pairwise.map((judge) =>
            judge.compared && judge.winRate !== undefined
              ? ` ${judge.judge} prefers it in ${pct(judge.winRate)} of cases.`
              : ''
          )}
        </span>
      </span>
    </li>
  );
}

/** The answer first: which variants are better, worse, or unclear. */
function Result({ data }: { data: MCPRunReportData }) {
  const single = data.variants.length === 1;
  const only = data.variants[0];
  if (single && only) {
    const rate = rateOf(data, only);
    const entry = data.comparison.variants[0];
    const cases = data.comparison.cases;
    const fullyPassing = cases.filter((row) =>
      (row.trials[only.id] ?? []).every((t) => t.pass)
    ).length;
    const previous = data.previousRun;
    return (
      <div className="grid grid-cols-[auto_1fr] items-center gap-6 rounded-lg border bg-card p-6">
        <div
          className={`font-mono text-6xl font-bold tabular-nums ${
            rate === undefined
              ? ''
              : rate >= 0.9
                ? RATE_TONE.better
                : rate < 0.5
                  ? RATE_TONE.worse
                  : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          {rate !== undefined ? pct(rate) : '—'}
        </div>
        <div className="grid gap-1">
          {previous ? (
            <span
              className={`w-fit rounded-full px-2 py-px text-xs font-semibold ${
                previous.passRateDelta > 0.0005
                  ? TONE.good
                  : previous.passRateDelta < -0.0005
                    ? TONE.bad
                    : TONE.neutral
              }`}
            >
              {previous.passRateDelta > 0.0005
                ? '▲'
                : previous.passRateDelta < -0.0005
                  ? '▼'
                  : '='}{' '}
              {pts(previous.passRateDelta)} pts since the previous run
              {previous.sameConfig ? '' : ' (eval config changed)'}
            </span>
          ) : (
            <span
              className={`w-fit rounded-full px-2 py-px text-xs ${TONE.neutral}`}
            >
              first run of this eval
            </span>
          )}
          <p className="text-lg">
            of trials passed. {fullyPassing} of {cases.length}{' '}
            {cases.length === 1 ? 'case' : 'cases'} passed every trial.
          </p>
          <p className="text-sm text-muted-foreground">
            {cases.length - fullyPassing}{' '}
            {cases.length - fullyPassing === 1 ? 'case needs' : 'cases need'}{' '}
            attention
            {only.previous && only.previous.regressed.length
              ? `; ${only.previous.regressed.length} regressed since the previous run`
              : ''}
            {entry && entry.failedTrials > 0
              ? `. ${entry.failedTrials} of ${entry.trials} trials failed.`
              : '.'}
          </p>
        </div>
      </div>
    );
  }
  const candidates = data.variants.filter((v) => !v.baseline);
  const baseline = data.variants.find((v) => v.baseline);
  return (
    <div className="grid gap-5 rounded-lg border bg-card p-6">
      <table className="w-full text-sm">
        <caption className="mb-3 text-left font-semibold">
          Share of trials passed, each variant against{' '}
          <span className="font-mono">{baseline?.name}</span>
        </caption>
        <tbody>
          {data.variants.map((variant) => {
            const rate = rateOf(data, variant);
            const bar =
              variant.verdict === 'better'
                ? 'bg-green-600 dark:bg-green-400'
                : variant.verdict === 'worse'
                  ? 'bg-red-600 dark:bg-red-400'
                  : 'bg-muted-foreground/50';
            return (
              <tr key={variant.id}>
                <th
                  scope="row"
                  className="w-[1%] whitespace-nowrap py-1 pr-4 text-left font-mono font-semibold"
                >
                  {variant.name}
                </th>
                <td className="py-1 pr-4">
                  <div className="h-3 rounded-full bg-muted" aria-hidden="true">
                    <div
                      className={`h-3 rounded-full ${bar}`}
                      style={{ width: `${(rate ?? 0) * 100}%` }}
                    />
                  </div>
                </td>
                <td
                  className={`w-[1%] whitespace-nowrap py-1 pr-4 text-right font-mono text-2xl font-bold tabular-nums ${RATE_TONE[variant.verdict]}`}
                >
                  {rate !== undefined ? pct(rate) : '—'}
                </td>
                <td className="w-[1%] whitespace-nowrap py-1">
                  <span
                    className={`rounded-full px-2 py-px text-xs font-semibold ${TONE[VERDICT_TONE[variant.verdict]]}`}
                  >
                    {VERDICT_LABEL[variant.verdict]}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="grid gap-2 text-sm">
        {candidates.map((variant) => (
          <VariantSentence key={variant.id} data={data} variant={variant} />
        ))}
      </ul>
      {!data.run.baselineRan && (
        <p className={`rounded px-2 py-1 text-sm ${TONE.warn}`}>
          The baseline <span className="font-mono">{data.run.baseline}</span>{' '}
          didn't run in this narrowed run, so variants are compared with{' '}
          <span className="font-mono">{baseline?.name}</span>.
        </p>
      )}
    </div>
  );
}

function Header({ data }: { data: MCPRunReportData }) {
  const { run } = data;
  const baseline = data.variants.find((v) => v.baseline);
  const clients = [
    ...new Set(
      data.variants
        .map((v) => [v.client, v.model].filter(Boolean).join(' · '))
        .filter(Boolean)
    ),
  ];
  return (
    <header className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {run.evalName}
        </h1>
        {clients.length === 1 && (
          <span className="font-mono text-sm text-muted-foreground">
            {clients[0]}
          </span>
        )}
      </div>
      <p className="text-[15px] text-muted-foreground">
        Run <span className="font-mono">{run.runId}</span> ·{' '}
        {new Date(run.createdAt).toLocaleString()} · {run.cases}{' '}
        {run.cases === 1 ? 'case' : 'cases'} × {trialsText(data)}
        {data.variants.length > 1 && baseline && (
          <>
            {' '}
            · baseline <span className="font-mono">{baseline.name}</span>
          </>
        )}
        {run.redacted && (
          <span
            className={`ml-2 rounded-full px-2 py-px text-xs font-semibold ${TONE.neutral}`}
            title="The run stored responses redacted (redactStoredResponses), so trials show no answers, tool outputs or judges' reasoning. Set redactStoredResponses: false in the eval config to keep them."
          >
            responses redacted
          </span>
        )}
        {run.partial && (
          <span
            className={`ml-2 rounded-full px-2 py-px text-xs font-semibold ${TONE.warn}`}
            title={JSON.stringify(run.selection ?? {})}
          >
            partial run
          </span>
        )}
      </p>
    </header>
  );
}

function RunDetails({ data }: { data: MCPRunReportData }) {
  const { run } = data;
  const seconds =
    (new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime()) /
    1000;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Run details
      </summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Run</dt>
        <dd className="font-mono">{run.runId}</dd>
        <dt className="text-muted-foreground">Took</dt>
        <dd>{seconds >= 0 ? `${seconds.toFixed(0)} s` : '—'}</dd>
        <dt className="text-muted-foreground">Datasets</dt>
        <dd>
          {run.datasets.map((d) => `${d.name} (${d.caseCount})`).join(', ')}
        </dd>
        {run.selection && (
          <>
            <dt className="text-muted-foreground">Narrowed by</dt>
            <dd className="font-mono">{JSON.stringify(run.selection)}</dd>
          </>
        )}
        {data.variants.map((v) => (
          <span key={v.id} className="contents">
            <dt className="font-mono text-muted-foreground">{v.name}</dt>
            <dd className="font-mono">
              {[v.client, v.model].filter(Boolean).join(' · ') || '—'}
            </dd>
          </span>
        ))}
        {data.previousRun && (
          <>
            <dt className="text-muted-foreground">Previous run</dt>
            <dd className="font-mono">
              {data.previousRun.runId} ({pct(data.previousRun.passRate)})
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">MST</dt>
        <dd className="font-mono">{run.mstVersion}</dd>
      </dl>
    </details>
  );
}

/**
 * An eval run's report: the result, the variants compared with the
 * baseline, what differs, every case, and why trials failed. Renders
 * `MCPRunReportData` as `buildRunReport` computed it.
 */
export function RunReport({ data }: { data: MCPRunReportData }) {
  const optimization = data.toolOptimization;
  // A run that only optimized tool metadata is its optimization's report.
  if (optimization?.comparison && data.variants.length === 0)
    return (
      <div className="mx-auto grid max-w-[1180px] gap-8 px-6 py-8">
        <ComparisonView
          optimization={optimization}
          data={optimization.comparison}
        />
      </div>
    );
  return <EvalRunReport data={data} />;
}

function EvalRunReport({ data }: { data: MCPRunReportData }) {
  const optimization = data.toolOptimization;
  const comparison = data.comparison;
  const single = data.variants.length === 1;
  const candidates = data.variants.filter((v) => !v.baseline);
  const [selectedId, setSelectedId] = useState(
    candidates[0]?.id ?? comparison.baselineId
  );
  const [filter, setFilter] = useState<CaseFilter>(single ? 'unsteady' : 'all');
  const selected = data.variants.find((v) => v.id === selectedId);
  const selectedEntry = comparison.variants.find((v) => v.id === selectedId);
  const baseline = data.variants.find((v) => v.baseline);

  return (
    <TrialLookupContext.Provider
      value={{
        trials: data.trials,
        preferences: data.preferences,
        baselineId: comparison.baselineId,
        redacted: data.run.redacted,
      }}
    >
      <div className="mx-auto grid max-w-[1180px] gap-12 px-6 py-8">
        <div className="grid gap-3">
          <Header data={data} />
          <RunDetails data={data} />
        </div>

        {optimization?.comparison && (
          <section aria-labelledby="run-opt-h" className="grid gap-4">
            <h2
              id="run-opt-h"
              className="text-sm font-semibold text-muted-foreground"
            >
              Tool optimization
            </h2>
            <ComparisonView
              optimization={optimization}
              data={optimization.comparison}
            />
          </section>
        )}

        <section aria-labelledby="run-result-h" className="grid gap-2">
          <h2
            id="run-result-h"
            className="text-sm font-semibold text-muted-foreground"
          >
            Result
          </h2>
          <Result data={data} />
        </section>

        {!single && (
          <VariantTable
            data={comparison}
            selectedId={selectedId}
            onSelect={setSelectedId}
            report={data}
          />
        )}

        {!single && selected && !selected.baseline && baseline && (
          <SetupDiff
            variant={selected}
            baselineName={baseline.name}
            differences={data.differences[selected.name] ?? []}
            toolChanges={selectedEntry?.toolChanges ?? []}
          />
        )}

        <CaseGrid
          data={comparison}
          selectedId={selectedId}
          filter={filter}
          onFilter={setFilter}
        />

        <TrialFailures data={comparison} selectedId={selectedId} />
      </div>
    </TrialLookupContext.Provider>
  );
}
