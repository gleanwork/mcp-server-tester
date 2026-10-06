import React from 'react';
import type {
  MCPComparisonData,
  PairedChange,
  VariantComparisonEntry,
} from '../../types';
import {
  TONE,
  betterThreshold,
  heldOutUnconfirmed,
  pValue,
  pct,
  points,
  pts,
  rangeText,
  variantName,
} from './format';

interface RecommendationProps {
  data: MCPComparisonData;
  /** What the variants changed, e.g. "description". */
  what: string;
  /** The metric the experiment optimized. */
  metric: string;
  onShowUnsteady: () => void;
}

/**
 * Fewest cases whose result must change for an improvement to be clear: the
 * exact sign-flip test's smallest p-value is 0.5^n, with n the cases whose
 * score changed.
 */
function casesToShowImprovement(data: MCPComparisonData): number {
  return Math.floor(Math.log2(1 / betterThreshold(data))) + 1;
}

interface Check {
  ok: boolean;
  title: string;
  value: string;
  lines: string[];
  range?: string;
}

function keepWorkingIds(data: MCPComparisonData): Set<string> {
  return new Set(
    data.cases.filter((c) => c.group === 'regression').map((c) => c.id)
  );
}

/** Passes over trials for one case and variant, e.g. "5/5". */
function score(
  data: MCPComparisonData,
  caseId: string,
  variantId: string
): string {
  const trials =
    data.cases.find((c) => c.id === caseId)?.trials[variantId] ?? [];
  return `${trials.filter((a) => a.pass).length}/${trials.length}`;
}

/** The cases a variant broke on their own, in a few words. */
function brokenText(
  data: MCPComparisonData,
  v: VariantComparisonEntry
): React.ReactNode {
  const ids = v.brokenCaseIds;
  const first = ids[0]!;
  if (ids.length === 1) {
    return (
      <>
        <b className="font-mono">{first}</b> fell from{' '}
        {score(data, first, data.baselineId)} to{' '}
        <b>{score(data, first, v.id)}</b>
      </>
    );
  }
  return (
    <>
      <b>{ids.length} cases</b> that pass today broke, including{' '}
      <span className="font-mono">{first}</span> (
      {score(data, first, data.baselineId)} to {score(data, first, v.id)})
    </>
  );
}

/** "p = 0.004, needs below 0.008 with 3 variants tried". */
function betterEvidence(data: MCPComparisonData, change: PairedChange): string {
  const needs = betterThreshold(data);
  const tried =
    data.variantsTried > 1 ? ` with ${data.variantsTried} variants tried` : '';
  return `${pValue(change.pBetter)}, needs below ${trimP(needs)}${tried}`;
}

function trimP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : String(Number(p.toPrecision(2)));
}

function checksFor(
  data: MCPComparisonData,
  pick: VariantComparisonEntry,
  base: VariantComparisonEntry
): Check[] {
  const sw = pick.capability;
  const kw = pick.regression;
  const heldOut = sw.heldOutChange;
  const fixes: Check =
    sw.cases === 0 || sw.passRate === undefined
      ? {
          ok: pick.checks?.fixes ?? false,
          title: 'Clearly better',
          value: '—',
          lines: ['There are no capability cases to improve.'],
        }
      : {
          ok: pick.checks?.fixes ?? false,
          title: 'Clearly better',
          value: `${pts(sw.change?.mean ?? 0)} pts`,
          lines: [
            `${pct(sw.passRate)} of trials pass on capability cases, vs ${pct(base.capability.passRate ?? 0)} today`,
            ...(sw.heldOutPassRate !== undefined && heldOut
              ? [
                  `${pct(sw.heldOutPassRate)} on held-out cases (${pts(heldOut.mean)} pts${
                    heldOut.assessment === 'better'
                      ? ', also clearly better'
                      : ', not clear on their own'
                  })`,
                ]
              : []),
          ],
          range: sw.change
            ? `95% range ${rangeText(sw.change)} · ${betterEvidence(data, sw.change)}`
            : undefined,
        };

  let keepLine: string;
  if (kw.cases === 0 || kw.passRate === undefined) {
    keepLine = 'There are no regression cases, so nothing was checked.';
  } else if (data.regressionCheck === 'significant' && kw.change) {
    const broken = pick.brokenCaseIds.length;
    keepLine =
      broken > 0
        ? `${broken} ${broken === 1 ? 'case' : 'cases'} clearly broke`
        : kw.change.assessment === 'worse'
          ? `clearly worse as a group, by ${points(kw.change.mean)} pts`
          : Math.abs(kw.change.mean) < 0.0005
            ? 'no change'
            : `the ${pts(kw.change.mean)} pt change is within noise`;
  } else {
    const keep = keepWorkingIds(data);
    const broken = pick.regressedCaseIds.filter((id) => keep.has(id)).length;
    keepLine =
      broken === 0
        ? 'no regression case got worse'
        : `${broken} regression ${broken === 1 ? 'case' : 'cases'} got worse`;
  }
  const keeps: Check = {
    ok: pick.checks?.keepsRegressions ?? false,
    // "No clear breakage", not "doesn't break": a test can only fail to find
    // breakage, and with few cases or trials it may miss some.
    title: 'No clear breakage',
    value: kw.passRate === undefined ? '—' : pct(kw.passRate),
    lines:
      kw.passRate === undefined
        ? [keepLine]
        : [
            `of trials pass on regression cases (${pct(base.regression.passRate ?? 0)} today)`,
            keepLine,
          ],
    range:
      data.regressionCheck === 'significant' && kw.change && kw.cases > 0
        ? `95% range ${rangeText(kw.change)} · ${pValue(kw.change.pWorse)} for worse`
        : undefined,
  };
  return [fixes, keeps];
}

/** Why a variant wasn't chosen, as one sentence plus its key number. */
function whyNot(
  data: MCPComparisonData,
  v: VariantComparisonEntry,
  pick: VariantComparisonEntry | undefined
): React.ReactNode {
  const unconfirmed = heldOutUnconfirmed(v) ? (
    <> Its gain also isn’t clear on held-out cases.</>
  ) : null;

  if (v.status === 'breaks') {
    const change = v.regression.change;
    if (data.regressionCheck === 'significant') {
      if (v.brokenCaseIds.length > 0) {
        return (
          <>
            Breaks what works: {brokenText(data, v)}.{unconfirmed}
          </>
        );
      }
      if (change?.assessment === 'worse') {
        return (
          <>
            Breaks what works: <b>{pts(change.mean)} pts</b> on cases that must
            keep working ({pValue(change.pWorse)}).{unconfirmed}
          </>
        );
      }
    }
    const keep = keepWorkingIds(data);
    const broken = v.regressedCaseIds.filter((id) => keep.has(id)).length;
    return (
      <>
        Breaks what works:{' '}
        <b>
          {broken} regression {broken === 1 ? 'case' : 'cases'}
        </b>{' '}
        got worse.{unconfirmed}
      </>
    );
  }
  if (pick && v.capability.passRate !== undefined) {
    const gap = (pick.capability.passRate ?? 0) - v.capability.passRate;
    return (
      <>
        <b>{points(gap)} pts</b> lower than{' '}
        <span className="font-mono">{variantName(data, pick)}</span>.
        {unconfirmed}
      </>
    );
  }
  const change = v.capability.change;
  return (
    <>
      Not clearly better than the baseline
      {change ? (
        <>
          {' '}
          (<b>{pts(change.mean)} pts</b>; {betterEvidence(data, change)})
        </>
      ) : null}
      .{unconfirmed}
    </>
  );
}

function ruleText(data: MCPComparisonData): string {
  const trials =
    data.trialsPerCase > 1
      ? ` Each case scores the share of its ${data.trialsPerCase} trials that passed, and variants are compared case by case.`
      : ' Variants are compared case by case.';
  const groups =
    data.grouping === 'declared'
      ? ` Cases tagged \u201c${data.regressionTag}\u201d are regression cases; the rest are capability cases.`
      : ` No case was tagged \u201c${data.regressionTag}\u201d, so the baseline ran once more just to sort cases: those that passed every trial are regression cases, the rest capability cases. Sorting by the run variants are compared against would make flaky cases look broken or fixed by chance.`;
  const better = ` \u201cClearly better\u201d means an exact paired sign-flip test gives p below ${trimP(betterThreshold(data))}${
    data.variantsTried > 1
      ? ` (${data.alpha} divided by the ${data.variantsTried} variants tried, so trying many can\u2019t promote a lucky one)`
      : ''
  }.`;
  const heldOut = ` Cases tagged \u201c${data.heldOutTag}\u201d are left out of ranking and never shown to proposeVariants, so they are a fair check on the winner.`;
  if (data.regressionCheck === 'significant') {
    return (
      'A variant qualifies when it is clearly better than the baseline on capability cases, and no regression case clearly broke.' +
      trials +
      groups +
      better +
      ` Something broke if the regression cases got worse as a group (p below ${data.alpha}), or any one of them did on its own (Fisher\u2019s exact test, Holm-corrected so the chance of wrongly calling any case broken stays below ${data.caseAlpha}). A single flaky trial doesn\u2019t count. Of the variants that qualify, the one with the highest score wins.` +
      heldOut
    );
  }
  return (
    'This run used regressionCheck: \u2018any-case\u2019, so a variant qualifies only when no regression case fails with it, even by one trial.' +
    trials +
    groups +
    better +
    ' Of the variants that qualify, the one with the highest score wins.' +
    heldOut
  );
}

export function Recommendation({
  data,
  what,
  metric,
  onShowUnsteady,
}: RecommendationProps) {
  const base = data.variants.find((v) => v.id === data.baselineId)!;
  const pick = data.variants.find((v) => v.id === data.recommendedId);
  const others = data.variants
    .filter((v) => v.id !== data.baselineId && v.id !== data.recommendedId)
    .sort(
      (a, b) => (b.capability.passRate ?? 0) - (a.capability.passRate ?? 0)
    );
  const checks = pick ? checksFor(data, pick, base) : [];

  const caveats: Array<{ text: React.ReactNode; action?: () => void }> = [];
  if (pick && pick.unsteadyCaseIds.length > 0) {
    const n = pick.unsteadyCaseIds.length;
    caveats.push({
      text: (
        <>
          <b>
            {n} {n === 1 ? 'case passes' : 'cases pass'}
          </b>{' '}
          only some of the time. The tool is right for {n === 1 ? 'it' : 'them'}
          , but not reliably.
        </>
      ),
      action: onShowUnsteady,
    });
  }
  if (pick && heldOutUnconfirmed(pick)) {
    caveats.push({
      text: (
        <>
          Its gain is clear overall but <b>not on held-out cases</b>, which
          ranking never used. It may fit the other cases better than it
          generalizes; add held-out cases or trials to check.
        </>
      ),
    });
  }
  if (data.trialsPerCase === 1) {
    caveats.push({
      text: (
        <>
          Each case ran <b>once</b>, so only large changes can show up as clear,
          and a broken case can’t be told from a flaky one. Set{' '}
          <code className="font-mono">trials</code> to run several trials per
          case.
        </>
      ),
    });
  }
  // passRate is judged on capability cases, the tool metrics on every case;
  // an arm metric has no per-case test.
  const tested =
    metric === 'passRate'
      ? data.cases.filter((c) => c.group === 'capability').length
      : ['toolF1', 'toolPrecision', 'toolRecall'].includes(metric)
        ? data.cases.length
        : undefined;
  const needed = casesToShowImprovement(data);
  if (
    !pick &&
    tested !== undefined &&
    data.variantsTried > 0 &&
    tested < needed
  ) {
    caveats.unshift({
      text: (
        <>
          With {tested} {metric === 'passRate' ? 'capability ' : ''}
          {tested === 1 ? 'case' : 'cases'},{' '}
          <b>no variant could be shown clearly better</b>: the smallest possible
          p is {trimP(0.5 ** tested)}. Add cases so at least {needed} can
          change.
        </>
      ),
    });
  }
  const keepCases = data.cases.filter((c) => c.group === 'regression').length;
  if (
    data.regressionCheck === 'significant' &&
    keepCases > 0 &&
    data.trialsPerCase > 1 &&
    (data.regressionTrialsPerCase ?? 0) < data.trialsToDetectBrokenCase
  ) {
    caveats.push({
      text: (
        <>
          With {data.regressionTrialsPerCase} trials per case and {keepCases}{' '}
          regression cases, <b>one case breaking can’t be caught on its own</b>,
          only breakage across several. Run at least{' '}
          {data.trialsToDetectBrokenCase} trials per case to catch it.
        </>
      ),
    });
  }
  if (data.grouping === 'grouping-run' && data.variantsTried > 0) {
    caveats.push({
      text: (
        <>
          No case is tagged{' '}
          <code className="font-mono">{data.regressionTag}</code>, so an{' '}
          <b>extra baseline run</b> decided which cases are regression cases. A
          flaky case may land in either group. Tag the cases that must keep
          working to decide yourself and skip the extra run.
        </>
      ),
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      {pick ? (
        <div
          className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 ${TONE.good}`}
        >
          <span className="text-2xl font-bold">
            <span
              aria-hidden="true"
              className="text-green-600 dark:text-green-400"
            >
              ✓
            </span>{' '}
            Ship {variantName(data, pick)}
          </span>
          <span className="text-sm font-semibold">
            {checks.every((c) => c.ok) ? 'Passes both checks' : 'Recommended'}
          </span>
        </div>
      ) : (
        <div
          className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 ${TONE.bad}`}
        >
          <span className="text-2xl font-bold">
            <span aria-hidden="true">✕</span> Keep the current {what}
          </span>
          <span className="text-sm font-semibold">
            {others.length > 0 && others.every((v) => v.status === 'breaks')
              ? 'Every variant breaks regression cases'
              : others.some((v) => v.status === 'breaks')
                ? 'No variant is clearly better without breaking others'
                : 'No variant is clearly better than the baseline'}
          </span>
        </div>
      )}

      <div className="grid gap-5 p-5">
        {checks.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {checks.map((c) => (
              <div
                key={c.title}
                className={`grid content-start gap-0.5 rounded-md p-4 ${
                  c.ok ? 'bg-green-500/10' : 'bg-red-500/10'
                }`}
              >
                <div className="flex items-baseline gap-2 font-semibold">
                  <span
                    aria-hidden="true"
                    className={
                      c.ok
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }
                  >
                    {c.ok ? '✓' : '✕'}
                  </span>
                  <span>{c.title}</span>
                  <span className="sr-only">
                    {c.ok ? '(passed)' : '(failed)'}
                  </span>
                </div>
                <div
                  className={`mt-1 text-3xl font-bold tabular-nums ${
                    c.ok
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {c.value}
                </div>
                {c.lines.map((line) => (
                  <div key={line} className="text-sm text-muted-foreground">
                    {line}
                  </div>
                ))}
                {c.range && (
                  <div className="font-mono text-xs text-muted-foreground/80">
                    {c.range}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {others.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              Not chosen
            </h3>
            <ul className="grid gap-2">
              {others.map((v) => (
                <li
                  key={v.id}
                  className="grid gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm sm:grid-cols-[18px_200px_1fr]"
                >
                  <span
                    aria-hidden="true"
                    className="font-bold text-red-600 dark:text-red-400"
                  >
                    ✕
                  </span>
                  <span className="font-mono font-semibold">
                    {variantName(data, v)}
                  </span>
                  <span className="[&_b]:text-red-800 dark:[&_b]:text-red-300">
                    {whyNot(data, v, pick)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {caveats.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              Worth knowing
            </h3>
            <ul className="grid gap-2">
              {caveats.map((c, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[18px_1fr_auto] items-baseline gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm [&_b]:text-amber-800 dark:[&_b]:text-amber-300"
                >
                  <span
                    aria-hidden="true"
                    className="font-bold text-amber-600 dark:text-amber-400"
                  >
                    !
                  </span>
                  <span>{c.text}</span>
                  {c.action ? (
                    <button
                      type="button"
                      onClick={c.action}
                      className="whitespace-nowrap text-primary underline"
                    >
                      Show them
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            How this was decided
          </summary>
          <p className="mt-2 max-w-[90ch] text-muted-foreground">
            {ruleText(data)}
          </p>
        </details>
      </div>
    </div>
  );
}
