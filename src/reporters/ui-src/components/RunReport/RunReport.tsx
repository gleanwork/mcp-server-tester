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
import {
  TONE,
  direction,
  graderName,
  likelyText,
  likelyTitle,
  pct,
  pts,
  rangeText,
} from '../Comparison/format';
import { SetupDiff } from './SetupDiff';
import { ComparisonView } from '../Comparison/ComparisonView';
import { TrialLookupContext } from './TrialDetail';

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
  const moved = `${label} ${pct(baseRate)} → ${pct(rate)} (${change ? pts(change.mean) : pts(rate - baseRate)} pts)`;
  if (!change || change.upper - change.lower < 0.0005) return moved;
  // "No clear change" means this run can't tell, not that the two are the same.
  return change.assessment === 'unclear'
    ? `${moved}: no clear change, as anything from ${rangeText(change)} fits this run`
    : `${moved}, 95% range ${rangeText(change)}`;
}

/** "5 of 8 cases passed every trial; 4 of 24 trials failed." */
function CasesSentence({
  data,
  variant,
}: {
  data: MCPRunReportData;
  variant: RunReportVariant;
}) {
  const entry = data.comparison.variants.find((v) => v.id === variant.id);
  const cases = data.comparison.cases.filter((row) => row.trials[variant.id]);
  const fullyPassing = cases.filter((row) =>
    row.trials[variant.id]!.every((t) => t.pass)
  ).length;
  const infra = infraCount(data, variant.id);
  const failed = (entry?.failedTrials ?? 0) - infra;
  const graded = (entry?.trials ?? 0) - infra;
  return (
    <li>
      <span className="font-mono font-semibold">{variant.name}</span>:{' '}
      {fullyPassing} of {cases.length} {cases.length === 1 ? 'case' : 'cases'}{' '}
      passed every trial
      {failed > 0 ? `; ${failed} of ${graded} graded trials failed` : ''}.
    </li>
  );
}

/**
 * A variant's change since the previous run, from the same paired test as
 * the variant comparisons. Nothing when the eval config changed since.
 */
function SincePrevious({
  data,
  variant,
}: {
  data: MCPRunReportData;
  variant: RunReportVariant;
}) {
  const since = variant.previous;
  if (!data.previousRun?.sameConfig || !since) return null;
  const pill = 'rounded-full px-2 py-px text-xs font-semibold';
  const change = since.change;
  // A run from before the test was recorded: the delta, untested and grey.
  if (!change)
    return (
      <span className={`${pill} ${TONE.neutral}`}>
        {pts(since.passRateDelta)} pts since the previous run
      </span>
    );
  const dir = direction(change);
  const tone =
    dir === 'up' ? TONE.good : dir === 'down' ? TONE.bad : TONE.neutral;
  // Every case scored as before: no change, not an unclear one.
  const same =
    change.upper - change.lower < 0.0005 && Math.abs(change.mean) < 0.0005;
  return (
    <span
      className={`${pill} ${tone}`}
      title={
        same
          ? 'Every case passed as many trials as in the previous run.'
          : `Change since the previous run, paired over ${change.cases} ${change.cases === 1 ? 'case' : 'cases'}: 95% range ${rangeText(change)}.`
      }
    >
      {dir === 'up'
        ? `▲ ${pts(change.mean)} pts since the previous run`
        : dir === 'down'
          ? `▼ ${pts(change.mean)} pts since the previous run`
          : same
            ? 'no change since the previous run'
            : 'no clear change since the previous run'}
    </span>
  );
}

/** The first run of an eval, or one whose eval config changed: nothing to compare against. */
function PreviousRunNote({ data }: { data: MCPRunReportData }) {
  const previous = data.previousRun;
  if (previous?.sameConfig) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {previous ? (
        <>
          The eval config changed since the previous run (
          <span className="font-mono">{previous.runId}</span>), so there's no
          earlier run to compare with.
        </>
      ) : (
        'The first run of this eval: no earlier run to compare with.'
      )}
    </p>
  );
}

/** "about 60 min", "about 2.5 h". */
function minutesText(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `about ${Math.round(minutes)} min`;
  return `about ${(minutes / 60).toFixed(1)} h`;
}

/**
 * A run too thin to pin down its pass rates: says so, and what to run
 * next, with this run's numbers.
 */
function EvidenceNote({ data }: { data: MCPRunReportData }) {
  const evidence = data.evidence;
  if (!evidence?.tooWide) return null;
  let widest: { name: string; lower: number; upper: number } | undefined;
  for (const variant of data.variants) {
    const entry = data.comparison.variants.find((v) => v.id === variant.id);
    const interval = headlineGroup(entry)?.interval;
    if (
      interval?.tooWide &&
      (!widest || interval.upper - interval.lower > widest.upper - widest.lower)
    )
      widest = { name: variant.name, ...interval };
  }
  const k = evidence.trialsPerCase;
  const perCase = `${k} ${k === 1 ? 'trial' : 'trials'} per case`;
  const total = data.comparison.variants.reduce((sum, v) => sum + v.trials, 0);
  const several = data.variants.length > 1;
  // Where the true rate likely lies, in words: "anywhere from 13.2% to 99.8%".
  const range = widest ? (
    <>
      :{' '}
      {several ? (
        <>
          on <span className="font-mono">{widest.name}</span>, the true rate
        </>
      ) : (
        'it'
      )}
      {several ? ' is' : "'s"} likely anywhere from {pct(widest.lower)} to{' '}
      {pct(widest.upper)}
    </>
  ) : null;
  const next = evidence.suggestedTrialsPerCase;
  const estimate = [
    evidence.estimatedMinutes !== undefined
      ? minutesText(evidence.estimatedMinutes)
      : null,
    evidence.estimatedCostUsd !== undefined
      ? `$${evidence.estimatedCostUsd < 10 ? evidence.estimatedCostUsd.toFixed(2) : Math.round(evidence.estimatedCostUsd)}`
      : null,
  ].filter(Boolean);
  const [t90, t95] = evidence.trialsToShow;
  return (
    <div className={`grid gap-1 rounded px-3 py-2 text-sm ${TONE.warn}`}>
      <p>
        <span className="font-semibold">Too few trials to tell.</span>{' '}
        {evidence.allPassed ? (
          <>
            All {total} trials passed, but {perCase}{' '}
            {widest ? (
              // The low end is the weakest rate this run can't rule out.
              <>
                can't tell a server that always passes from one that passes{' '}
                {pct(widest.lower)} of the time
              </>
            ) : (
              "can't pin down a pass rate"
            )}
            .
          </>
        ) : (
          <>
            {perCase.charAt(0).toUpperCase() + perCase.slice(1)} can't pin down{' '}
            {several ? 'these pass rates' : 'the pass rate'}
            {range}.
          </>
        )}
      </p>
      <p>
        {next !== undefined ? (
          <>
            {data.run.selection?.trials !== undefined ? (
              // The run was narrowed with --trials: the same flag again.
              <>
                Run it again with{' '}
                <code className="font-mono">--trials {next}</code>
              </>
            ) : (
              <>
                Set{' '}
                <code className="font-mono">
                  "run": {'{'} "trials": {next} {'}'}
                </code>{' '}
                in the eval config (cases that set their own{' '}
                <code className="font-mono">trials</code> keep them) and run it
                again
              </>
            )}
            : {evidence.suggestedTrials} trials
            {estimate.length > 0
              ? `, ${estimate.join(' and ')} at this run's pace`
              : ''}
            . The evals guide advises 10 trials per case while developing an
            eval, and 20 before a release decision.
          </>
        ) : (
          // Too few cases, or cases too unlike each other: trials fix neither.
          <>
            More trials per case won't narrow it enough with {data.run.cases}{' '}
            {data.run.cases === 1 ? 'case' : 'cases'}: add cases.
          </>
        )}
      </p>
      {evidence.allPassed && t90 && t95 && (
        <p>
          Showing that a case passes at least {pct(t90.rate)} of the time takes{' '}
          {t90.trials} passing trials in a row; {pct(t95.rate)} takes{' '}
          {t95.trials}.
        </p>
      )}
    </div>
  );
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
  // A collect-only run has no pass rates: nothing has judged its answers.
  if (data.run.phases.grade === 'skipped')
    return (
      <div className="grid gap-2 rounded-lg border bg-card p-6">
        <p className="text-sm">
          <span className="font-semibold">Not graded.</span> These trials were
          collected with <span className="font-mono">mst run --no-grade</span>.
          Grade them with{' '}
          <span className="font-mono">
            mst grade {data.run.runId.split('-').pop()} -c &lt;eval config&gt;
          </span>
          .
        </p>
        <InfraNote data={data} />
      </div>
    );
  // A one-variant run is a comparison with one column: the same table, with
  // no verdicts because there is nothing to compare it with.
  const single = data.variants.length === 1;
  const candidates = data.variants.filter((v) => !v.baseline);
  const baseline = data.variants.find((v) => v.baseline);
  const split = hasRegressionCases(data);
  const entryOf = (variant: RunReportVariant) =>
    data.comparison.variants.find((v) => v.id === variant.id);
  return (
    <div className="grid gap-5 rounded-lg border bg-card p-6">
      <table className="w-full text-sm">
        <caption className="mb-3 text-left font-semibold">
          {single ? (
            'Pass rate, and where it likely lies'
          ) : (
            <>
              {split ? 'Each variant' : 'Pass rate, each variant'} against{' '}
              <span className="font-mono">{baseline?.name}</span>
            </>
          )}
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
              {!single && <td />}
              {data.previousRun && <td />}
            </tr>
          </thead>
        )}
        <tbody>
          {data.variants.map((variant) => {
            const group = headlineGroup(entryOf(variant));
            const rate = group?.passRate;
            const regression = entryOf(variant)?.regression;
            const interval = group?.interval;
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
                  <div
                    className="relative h-3 rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className={`h-3 rounded-full ${bar}`}
                      style={{ width: `${(rate ?? 0) * 100}%` }}
                    />
                    {interval && (
                      // The 95% range, drawn over the bar.
                      <div
                        className="absolute -inset-y-0.5 rounded-full border-2 border-foreground/40"
                        style={{
                          left: `${interval.lower * 100}%`,
                          width: `${Math.max(0.5, (interval.upper - interval.lower) * 100)}%`,
                        }}
                      />
                    )}
                  </div>
                </td>
                <td className="w-[1%] whitespace-nowrap py-1 pr-4 text-right">
                  <span
                    className={`block font-mono text-2xl font-bold tabular-nums ${RATE_TONE[tone]}`}
                  >
                    {rate !== undefined ? pct(rate) : '—'}
                  </span>
                  {interval && (
                    <span
                      className="block font-mono text-xs text-muted-foreground"
                      title={likelyTitle(interval, true)}
                    >
                      {likelyText(interval)}
                    </span>
                  )}
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
                {!single && (
                  <td className="w-[1%] whitespace-nowrap py-1 pr-4">
                    <span
                      className={`rounded-full px-2 py-px text-xs font-semibold ${TONE[VERDICT_TONE[variant.verdict]]}`}
                    >
                      {VERDICT_LABEL[variant.verdict]}
                    </span>
                  </td>
                )}
                {data.previousRun && (
                  <td className="w-[1%] whitespace-nowrap py-1">
                    <SincePrevious data={data} variant={variant} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <EvidenceNote data={data} />
      <ul className="grid gap-2 text-sm">
        {baseline && <CasesSentence data={data} variant={baseline} />}
        {candidates.map((variant) => (
          <VariantSentence key={variant.id} data={data} variant={variant} />
        ))}
      </ul>
      <PreviousRunNote data={data} />
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
        {phaseNote(run.phases) && (
          <span
            className={`ml-2 rounded-full px-2 py-px text-xs font-semibold ${TONE.warn}`}
            title={phaseNote(run.phases)!.title}
          >
            {phaseNote(run.phases)!.label}
          </span>
        )}
      </p>
    </header>
  );
}

/** A header note for a run that didn't finish collecting or grading. */
function phaseNote(
  phases: MCPRunReportData['run']['phases']
): { label: string; title: string } | null {
  if (phases.collect === 'failed')
    return {
      label: 'stopped early',
      title:
        'The run stopped on an error. This report shows the variants that finished before it.',
    };
  if (phases.collect === 'partial')
    return {
      label: 'incomplete',
      title:
        'Saved while variants were still to run: the run is still going, or was stopped before it finished.',
    };
  if (phases.grade === 'skipped')
    return {
      label: 'not graded',
      title:
        'Collected with mst run --no-grade: grade it with mst grade. It has no pass rates.',
    };
  if (phases.grade === 'partial')
    return {
      label: 'some trials not graded',
      title:
        "A grader couldn't score some trials (a judge error, for example). They're left out of pass rates.",
    };
  return null;
}

/** An environment's name, shards and each shard's machine. */
function EnvironmentDetails({
  label,
  environment,
}: {
  label: string;
  environment: NonNullable<MCPRunReportData['run']['environment']>;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">
        {environment.name}
        {environment.shards > 1 ? ` · ${environment.shards} shards` : ''}
        {environment.machines?.map((machine) => (
          <div key={machine.shard} className="text-muted-foreground">
            shard {machine.shard}:{' '}
            {[machine.image, machine.mst && `MST ${machine.mst}`]
              .filter(Boolean)
              .join(' · ') || '—'}
          </div>
        ))}
      </dd>
    </>
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
          {run.datasets
            .map(
              (d) =>
                `${d.name} (${d.caseCount})${d.contentHash ? ` · ${d.contentHash.slice(0, 12)}` : ''}`
            )
            .join(', ')}
        </dd>
        {run.environment && (
          <EnvironmentDetails
            label="Environment"
            environment={run.environment}
          />
        )}
        {run.gradingEnvironment && (
          <EnvironmentDetails
            label="Grading environment"
            environment={run.gradingEnvironment}
          />
        )}
        {run.clientApps && (
          <>
            <dt className="text-muted-foreground">Client app</dt>
            <dd className="font-mono">{run.clientApps.join(', ')}</dd>
          </>
        )}
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
  // A one-variant run opens on the cases that need attention, if any do.
  const needsAttention = comparison.cases.some((row) =>
    (row.trials[comparison.baselineId] ?? []).some((t) => !t.pass)
  );
  const [filter, setFilter] = useState<CaseFilter>(
    single && needsAttention ? 'unsteady' : 'all'
  );
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

        <VariantTable
          data={comparison}
          selectedId={selectedId}
          onSelect={setSelectedId}
          report={data}
        />

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
