import { useState } from 'react';
import type {
  MCPRunReportData,
  PairedChange,
  RunReportVariant,
  VariantComparisonEntry,
} from '../../types';
import {
  VariantTable,
  VERDICT_LABEL,
  VERDICT_TONE,
} from '../Comparison/VariantTable';
import { CaseGrid, type CaseFilter } from '../Comparison/CaseGrid';
import { TrialFailures } from '../Comparison/TrialFailures';
import { TONE, graderName, pct, pts, rangeText } from '../Comparison/format';
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

/** A rate's colour comes from its own change, not the variant's overall verdict. */
function assessmentTone(
  change: PairedChange | undefined
): RunReportVariant['verdict'] {
  if (!change) return 'baseline';
  return change.assessment === 'better'
    ? 'better'
    : change.assessment === 'worse'
      ? 'worse'
      : 'unclear';
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

/** "+1.2k tokens per trial (+86%)": how much more (or less) a variant spends. */
function costPhrases(
  data: MCPRunReportData,
  variant: RunReportVariant
): string[] {
  const baseline = data.variants.find((v) => v.baseline);
  const entry = data.comparison.variants.find((v) => v.id === variant.id);
  const baseEntry = data.comparison.variants.find(
    (v) => v.id === data.comparison.baselineId
  );
  const phrases: string[] = [];
  const tokens = entry?.meanTokensPerTrial;
  const baseTokens = baseEntry?.meanTokensPerTrial;
  if (tokens !== undefined && baseTokens !== undefined && baseTokens > 0) {
    const ratio = tokens / baseTokens - 1;
    phrases.push(
      Math.abs(ratio) < 0.05
        ? 'about the same tokens per trial'
        : `${signed(tokens - baseTokens, (x) => (x < 1000 ? `${Math.round(x)}` : `${(x / 1000).toFixed(1)}k`))} tokens per trial (${signed(ratio, (x) => `${Math.round(x * 100)}%`)})`
    );
  }
  const time = variant.medianDurationMs;
  const baseTime = baseline?.medianDurationMs;
  if (time !== undefined && baseTime !== undefined && baseTime > 0) {
    const diff = time - baseTime;
    phrases.push(
      Math.abs(diff) / baseTime < 0.05
        ? 'about the same median trial time'
        : `${signed(diff, (x) => `${(x / 1000).toFixed(1)} s`)} median trial time`
    );
  }
  const cost = variant.costPerCase;
  const baseCost = baseline?.costPerCase;
  if (cost !== undefined && baseCost !== undefined)
    phrases.push(
      Math.abs(cost - baseCost) < 0.0005
        ? 'about the same cost per case'
        : `${signed(cost - baseCost, (x) => `$${x.toFixed(3)}`)} per case`
    );
  return phrases;
}

/** Formats a signed difference: "+1.2k", "−0.4 s". */
function signed(x: number, format: (abs: number) => string): string {
  return `${x >= 0 ? '+' : '−'}${format(Math.abs(x))}`;
}

/** What a change in one case group says, in words: "0% → 88.9% (+88.9 pts)". */
function groupPhrase(
  label: string,
  rate: number | undefined,
  baseRate: number | undefined,
  change: PairedChange | undefined
): string | null {
  if (rate === undefined || baseRate === undefined) return null;
  if (change && Math.abs(change.mean) < 0.0005)
    return `${label} held at ${pct(rate)}`;
  // The change pairs the cases both sides scored, so the baseline's rate on
  // those cases is the variant's minus the change: the two always agree.
  if (change) baseRate = rate - change.mean;
  const range =
    change && change.upper - change.lower >= 0.0005
      ? `, 95% range ${rangeText(change)}`
      : '';
  return `${label} ${pct(baseRate)} → ${pct(rate)} (${change ? pts(change.mean) : pts(rate - baseRate)} pts${range})`;
}

/** One sentence per variant: how it compares with the baseline, and what it costs. */
function VariantSentence({
  data,
  variant,
}: {
  data: MCPRunReportData;
  variant: RunReportVariant;
}) {
  const entry = data.comparison.variants.find((v) => v.id === variant.id);
  const baseEntry = data.comparison.variants.find(
    (v) => v.id === data.comparison.baselineId
  );
  const split = hasRegressionCases(data);
  const worse = entry?.regressedCaseIds.length ?? 0;
  const better = entry?.improvedCaseIds.length ?? 0;
  const groups = [
    groupPhrase(
      split ? 'capability cases' : 'pass rate',
      headlineGroup(entry)?.passRate,
      headlineGroup(baseEntry)?.passRate,
      headlineGroup(entry)?.change
    ),
    split
      ? groupPhrase(
          'regression cases',
          entry?.regression.passRate,
          baseEntry?.regression.passRate,
          entry?.regression.change
        )
      : null,
  ].filter(Boolean);
  const costs = costPhrases(data, variant);
  return (
    <li>
      <span className="font-mono font-semibold">{variant.name}</span>:{' '}
      {groups.join('; ')}. {better} {better === 1 ? 'case' : 'cases'} better,{' '}
      {worse} worse.
      {variant.pairwise.map((judge) =>
        judge.compared && judge.winRate !== undefined
          ? ` ${judge.judge} prefers it in ${pct(judge.winRate)} of cases.`
          : ''
      )}
      {costs.length > 0 && (
        <span className="text-muted-foreground">
          {' '}
          Against the baseline: {costs.join(', ')}.
        </span>
      )}
    </li>
  );
}

/** The cases a variant's headline rate covers: capability cases, or the regression cases when there are no others. */
function headlineGroup(entry: VariantComparisonEntry | undefined) {
  if (!entry) return undefined;
  return entry.capability.cases > 0 ? entry.capability : entry.regression;
}

function hasRegressionCases(data: MCPRunReportData): boolean {
  return (
    data.comparison.cases.some((c) => c.group === 'regression') &&
    data.comparison.cases.some((c) => c.group === 'capability')
  );
}

const GRADER_TEXT: Record<string, string> = {
  toolsTriggered: 'which tools were called',
  toolCallCount: 'how many tool calls',
  textContains: 'the answer contains text',
  regex: 'the answer matches a pattern',
  exact: 'the response matches exactly',
  schema: 'the response matches a schema',
  snapshot: 'the response matches a snapshot',
  error: 'whether the response is an error',
  size: 'the response size',
};

/** Trials of a variant that ended in an infrastructure failure. */
function infraCount(data: MCPRunReportData, variantId: string): number {
  return Object.values(data.trials[variantId] ?? {})
    .flat()
    .filter((trial) => trial.infrastructureError).length;
}

/**
 * Trials that ended in a client or infrastructure failure (a timeout, a
 * client error) rather than an answer. They count as failed in every rate,
 * so the page says how many there were and what the first one was.
 */
function InfraNote({ data }: { data: MCPRunReportData }) {
  const failures: Array<{ variant: string; caseId: string; error?: string }> =
    [];
  for (const variant of data.variants)
    for (const [caseId, list] of Object.entries(data.trials[variant.id] ?? {}))
      for (const trial of list)
        if (trial.infrastructureError)
          failures.push({
            variant: variant.name,
            caseId,
            ...(trial.error ? { error: trial.error } : {}),
          });
  if (failures.length === 0) return null;
  const first = failures[0]!;
  const n = failures.length;
  return (
    <p className={`w-fit rounded px-2 py-1 text-sm ${TONE.warn}`}>
      {n} {n === 1 ? 'trial' : 'trials'} ended in a client or infrastructure
      failure instead of an answer. Pass rates leave {n === 1 ? 'it' : 'them'}{' '}
      out; rerun {n === 1 ? 'that case' : 'those cases'} to grade{' '}
      {n === 1 ? 'it' : 'them'}. First:{' '}
      <span className="font-mono">
        {data.variants.length > 1 ? `${first.variant} · ` : ''}
        {first.caseId}
      </span>
      {first.error ? `: ${first.error}` : ''}
    </p>
  );
}

/** What decided pass or fail, and a warning when nothing read the answers. */
function GradedOn({ data }: { data: MCPRunReportData }) {
  const graders = data.graders;
  const ranTrials = Object.values(data.trials).some((byCase) =>
    Object.values(byCase).some((list) => list.length > 0)
  );
  if (graders.length === 0)
    return ranTrials ? (
      <p className={`w-fit rounded px-2 py-1 text-sm ${TONE.warn}`}>
        Nothing graded these trials: every trial that ran counts as passed. Add
        assertions or judges to the cases.
      </p>
    ) : null;
  const answersUngraded = graders.every((g) => !g.readsAnswer);
  return (
    <div className="grid gap-1 text-sm">
      <p className="text-muted-foreground">
        <span className="font-semibold text-foreground">Graded on:</span>{' '}
        {graders.map((g, i) => (
          <span key={g.name}>
            {i > 0 && ' · '}
            <span className="font-mono">{graderName(g.name)}</span>
            {g.judge
              ? ' (judge)'
              : GRADER_TEXT[g.name]
                ? ` (${GRADER_TEXT[g.name]})`
                : ''}
          </span>
        ))}
      </p>
      {answersUngraded && (
        <p className={`w-fit rounded px-2 py-1 ${TONE.warn}`}>
          No grader read the answers: a trial passes on the tools it called,
          even when its answer is wrong. Add a judge, or an assertion on the
          answer (<code className="font-mono">containsText</code>,{' '}
          <code className="font-mono">matchesPattern</code>), to check them.
        </p>
      )}
    </div>
  );
}

/** The answer first: which variants are better, worse, or unclear. */
function Result({ data }: { data: MCPRunReportData }) {
  const single = data.variants.length === 1;
  const only = data.variants[0];
  if (single && only) {
    const entry = data.comparison.variants[0];
    // The comparison's rate, as every other number on the page. Trials that
    // ended in an infrastructure failure are left out (InfraNote says so).
    const rate = headlineGroup(entry)?.passRate ?? rateOf(data, only);
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
            {entry && entry.failedTrials - infraCount(data, only.id) > 0
              ? `. ${entry.failedTrials - infraCount(data, only.id)} of ${entry.trials - infraCount(data, only.id)} graded trials failed.`
              : '.'}
          </p>
        </div>
        <div className="col-span-2 grid gap-2">
          <InfraNote data={data} />
          <GradedOn data={data} />
        </div>
      </div>
    );
  }
  const candidates = data.variants.filter((v) => !v.baseline);
  const baseline = data.variants.find((v) => v.baseline);
  const split = hasRegressionCases(data);
  const entryOf = (variant: RunReportVariant) =>
    data.comparison.variants.find((v) => v.id === variant.id);
  return (
    <div className="grid gap-5 rounded-lg border bg-card p-6">
      <table className="w-full text-sm">
        <caption className="mb-3 text-left font-semibold">
          {split ? 'Each variant' : 'Pass rate, each variant'} against{' '}
          <span className="font-mono">{baseline?.name}</span>
        </caption>
        {split && (
          <thead className="text-xs text-muted-foreground">
            <tr>
              <td />
              <th
                scope="col"
                colSpan={2}
                className="pb-1 text-left font-normal"
              >
                Capability cases (not tagged “{data.comparison.regressionTag}”)
              </th>
              <th scope="col" className="pb-1 pr-4 text-right font-normal">
                Regression cases
              </th>
              <td />
            </tr>
          </thead>
        )}
        <tbody>
          {data.variants.map((variant) => {
            const group = headlineGroup(entryOf(variant));
            const rate = group?.passRate;
            const regression = entryOf(variant)?.regression;
            const tone = assessmentTone(group?.change);
            const bar =
              tone === 'better'
                ? 'bg-green-600 dark:bg-green-400'
                : tone === 'worse'
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
                  className={`w-[1%] whitespace-nowrap py-1 pr-4 text-right font-mono text-2xl font-bold tabular-nums ${RATE_TONE[assessmentTone(group?.change)]}`}
                >
                  {rate !== undefined ? pct(rate) : '—'}
                </td>
                {split && (
                  <td
                    className={`w-[1%] whitespace-nowrap py-1 pr-4 text-right font-mono tabular-nums ${
                      regression?.change?.assessment === 'worse'
                        ? RATE_TONE.worse
                        : 'text-muted-foreground'
                    }`}
                  >
                    {regression?.passRate !== undefined
                      ? pct(regression.passRate)
                      : '—'}
                    {regression?.change?.assessment === 'worse' && (
                      <span className="ml-1 font-sans text-xs font-semibold">
                        ▼ worse
                      </span>
                    )}
                  </td>
                )}
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
      <InfraNote data={data} />
      <GradedOn data={data} />
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

/** "7 min", "42 s": how long the run took. */
function tookText(run: MCPRunReportData['run']): string | null {
  const seconds =
    (new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime()) /
    1000;
  if (!(seconds >= 0)) return null;
  return seconds < 120
    ? `${Math.round(seconds)} s`
    : `${Math.round(seconds / 60)} min`;
}

function Header({ data }: { data: MCPRunReportData }) {
  const { run } = data;
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
        {new Date(run.createdAt).toLocaleString()} · {run.cases}{' '}
        {run.cases === 1 ? 'case' : 'cases'} × {trialsText(data)} ·{' '}
        {data.variants.length}{' '}
        {data.variants.length === 1 ? 'variant' : 'variants'}
        {tookText(run) && <> · took {tookText(run)}</>}
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

        {!single && baseline && (
          <SetupDiff
            variants={(candidates.length <= 3
              ? candidates
              : [selected && !selected.baseline ? selected : candidates[0]!]
            ).map((variant) => ({
              variant,
              differences: data.differences[variant.name] ?? [],
              toolChanges:
                comparison.variants.find((v) => v.id === variant.id)
                  ?.toolChanges ?? [],
            }))}
            baselineName={baseline.name}
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
