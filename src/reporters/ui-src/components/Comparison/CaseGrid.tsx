import React, { useEffect, useRef, useState } from 'react';
import type {
  MCPComparisonData,
  RunReportTrial,
  VariantTrial,
  VariantComparisonCase,
  VariantComparisonEntry,
} from '../../types';
import { CaseCounts } from './VariantTable';
import { FAILURE_LABEL, pct, variantName } from './format';
import {
  Preferences,
  TrialView,
  traceSummary,
  useTrialLookup,
} from '../RunReport/TrialDetail';

/** "All 3 trials passed and made the same calls", when a side's trials agree. */
function sameNote(trials: RunReportTrial[]): string | null {
  if (trials.length < 2) return null;
  const first = trials[0]!;
  const signature = (t: RunReportTrial) =>
    JSON.stringify(
      t.events
        .filter((e) => e.kind === 'tool_call')
        .map((e) => [e.name, e.input])
    );
  const same = trials.every(
    (t) => t.pass === first.pass && signature(t) === signature(first)
  );
  if (!same) return null;
  const calls = traceSummary(first);
  return calls === 'called no tools'
    ? `All ${trials.length} trials ${first.pass ? 'passed' : 'failed'} and called no tools.`
    : `All ${trials.length} trials ${first.pass ? 'passed' : 'failed'}, with the same tool calls.`;
}

export type CaseFilter = 'all' | 'regressed' | 'improved' | 'unsteady';

interface CaseGridProps {
  data: MCPComparisonData;
  selectedId: string;
  filter: CaseFilter;
  onFilter: (filter: CaseFilter) => void;
}

function passes(row: VariantComparisonCase, id: string): number {
  return (row.trials[id] ?? []).filter((a) => a.pass).length;
}

interface Section {
  key: string;
  label: string;
  hint: string;
  rows: VariantComparisonCase[];
  rate: (v: VariantComparisonEntry) => number | undefined;
}

function sectionsOf(data: MCPComparisonData): Section[] {
  if (data.purpose === 'eval') {
    // An eval's cases are one group, unless some are tagged as regression cases.
    const regression = data.cases.filter((c) => c.group === 'regression');
    return [
      {
        key: 'cases',
        label: regression.length ? 'Capability cases' : 'All cases',
        hint: regression.length
          ? `not tagged “${data.regressionTag}”`
          : 'pass rate per variant',
        rows: data.cases.filter((c) => c.group === 'capability'),
        rate: (v: VariantComparisonEntry) => v.capability.passRate,
      },
      {
        key: 'keep',
        label: 'Regression cases',
        hint: `tagged “${data.regressionTag}”`,
        rows: regression,
        rate: (v: VariantComparisonEntry) => v.regression.passRate,
      },
    ].filter((s) => s.rows.length > 0);
  }
  const capability = data.cases.filter((c) => c.group === 'capability');
  const hasHeldOut = capability.some((c) => c.heldOut);
  const seen = capability.filter((c) => !c.heldOut);
  const sections: Section[] = [
    {
      key: 'seen',
      label: 'Capability cases',
      hint: hasHeldOut
        ? 'seen while writing the variants'
        : 'the baseline fails these',
      rows: seen,
      rate: (v) =>
        hasHeldOut ? v.capability.seenPassRate : v.capability.passRate,
    },
    {
      key: 'held-out',
      label: 'Capability cases',
      hint: `held out: not seen while writing (tag “${data.heldOutTag}”)`,
      rows: capability.filter((c) => c.heldOut),
      rate: (v) => v.capability.heldOutPassRate,
    },
    {
      key: 'keep',
      label: 'Regression cases',
      hint: 'the baseline passes these',
      rows: data.cases.filter((c) => c.group === 'regression'),
      rate: (v) => v.regression.passRate,
    },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

function Cell({
  row,
  variant,
  data,
  selected,
  onOpen,
}: {
  row: VariantComparisonCase;
  variant: VariantComparisonEntry;
  data: MCPComparisonData;
  selected: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const trials = row.trials[variant.id];
  if (!trials) {
    return (
      <td
        className={`p-1 text-center text-xs text-muted-foreground ${selected ? 'bg-primary/5' : ''}`}
      >
        not run
      </td>
    );
  }
  const p = trials.filter((a) => a.pass).length;
  const k = trials.length;
  const isBase = variant.id === data.baselineId;
  const d = isBase ? 0 : p - passes(row, data.baselineId);
  const change = d > 0 ? 'up' : d < 0 ? 'down' : null;
  // Red for failing every trial or getting worse; green for passing every
  // trial; amber for passing some. The baseline's cells are grey: they are
  // what the others are compared with, and its dots still say pass or fail.
  const tone =
    isBase && data.variants.length > 1
      ? 'bg-muted/70'
      : p === 0 || change === 'down'
        ? 'bg-red-500/10'
        : p === k
          ? 'bg-green-500/10'
          : 'bg-amber-500/10';
  const label = `${variantName(data, variant)}, ${row.id}: ${p} of ${k} trials passed${
    change
      ? `, ${change === 'up' ? 'better' : 'worse'} than ${variantName(data, { id: data.baselineId })}`
      : ''
  }. Open trials.`;
  return (
    <td className={`p-1 text-center ${selected ? 'bg-primary/5' : ''}`}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => onOpen(e.currentTarget)}
        className={`relative grid min-h-[44px] w-full justify-items-center gap-0.5 rounded-md border border-transparent p-1 hover:border-border ${tone}`}
      >
        {change && (
          <span
            aria-hidden="true"
            className={`absolute right-1 top-0.5 text-xs font-bold ${
              change === 'up'
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {change === 'up' ? '▲' : '▼'}
          </span>
        )}
        <span
          className="inline-flex flex-wrap justify-center gap-[3px]"
          aria-hidden="true"
        >
          {trials.map((a, i) => (
            <span
              key={i}
              className={`h-[9px] w-[9px] rounded-full ${
                a.pass
                  ? 'bg-green-600 dark:bg-green-400'
                  : 'bg-red-500 dark:bg-red-400'
              }`}
            />
          ))}
        </span>
        <span
          className="font-mono text-xs text-muted-foreground"
          aria-hidden="true"
        >
          {p}/{k}
        </span>
      </button>
    </td>
  );
}

function AttemptList({ trials }: { trials: VariantTrial[] }) {
  return (
    <ol className="grid gap-2">
      {trials.map((a, i) => (
        <li key={i} className="grid gap-1 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Trial {i + 1}</span>
            <span
              className={`rounded px-1.5 font-bold ${
                a.pass
                  ? 'bg-green-500/10 text-green-800 dark:text-green-300'
                  : 'bg-red-500/10 text-red-800 dark:text-red-300'
              }`}
            >
              {a.pass ? 'PASS' : 'FAIL'}
            </span>
          </div>
          {a.failure && <div>{FAILURE_LABEL[a.failure]}</div>}
          {a.calls !== undefined && (
            <div className="font-mono text-muted-foreground">
              called: {a.calls.length > 0 ? a.calls.join(' → ') : 'nothing'}
            </div>
          )}
          {a.missed && a.missed.length > 0 && (
            <div className="font-mono text-muted-foreground">
              missed: {a.missed.join(', ')}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function AttemptDialog({
  data,
  row,
  variantId,
  onClose,
}: {
  data: MCPComparisonData;
  row: VariantComparisonCase;
  variantId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const lookup = useTrialLookup();
  const sides = [
    data.baselineId,
    ...(variantId === data.baselineId ? [] : [variantId]),
  ];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      aria-labelledby="exp-trials-h"
      className="w-[min(900px,96vw)] rounded-lg border bg-background p-0 text-foreground backdrop:bg-black/50"
    >
      <div className="grid gap-3 border-b p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="exp-trials-h" className="font-mono font-semibold">
              {row.id}
            </h2>
            {row.input && <p className="text-sm">“{row.input}”</p>}
            {row.expectedTools && (
              <p className="text-xs text-muted-foreground">
                expects{' '}
                <span className="font-mono">
                  {row.expectedTools.join(', ')}
                </span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Close
          </button>
        </div>
      </div>
      {lookup?.redacted && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          This run stored responses redacted, so answers, tool outputs and
          judges’ reasoning aren’t shown. Set{' '}
          <code className="font-mono">redactStoredResponses: false</code> in the
          eval config to keep them.
        </p>
      )}
      <div
        className={`grid gap-4 p-4 ${sides.length > 1 ? 'md:grid-cols-2' : ''}`}
      >
        {sides.map((id) => (
          <div key={id} className="grid content-start gap-2">
            <h3 className="font-mono text-sm font-semibold">
              {variantName(data, { id })}{' '}
              <span className="font-sans font-normal text-muted-foreground">
                {passes(row, id)}/{(row.trials[id] ?? []).length} passed
              </span>
            </h3>
            {lookup?.trials[id]?.[row.id] ? (
              <>
                {id !== data.baselineId && (
                  <Preferences
                    preferences={lookup.preferences[id]?.[row.id] ?? []}
                  />
                )}
                {sameNote(lookup.trials[id]![row.id]!) && (
                  <p className="text-xs text-muted-foreground">
                    {sameNote(lookup.trials[id]![row.id]!)}
                  </p>
                )}
                <ol className="grid gap-2">
                  {lookup.trials[id]![row.id]!.map((trial, i) => (
                    <TrialView key={i} trial={trial} index={i} />
                  ))}
                </ol>
              </>
            ) : (
              <AttemptList trials={row.trials[id] ?? []} />
            )}
          </div>
        ))}
      </div>
    </dialog>
  );
}

export function CaseGrid({
  data,
  selectedId,
  filter,
  onFilter,
}: CaseGridProps) {
  const [sortByChange, setSortByChange] = useState(false);
  const [open, setOpen] = useState<{
    caseId: string;
    variantId: string;
  } | null>(null);
  const lastButton = useRef<HTMLButtonElement | null>(null);
  const base = data.baselineId;
  const selectedName = variantName(data, { id: selectedId });

  const tests: Record<CaseFilter, (row: VariantComparisonCase) => boolean> = {
    all: () => true,
    regressed: (row) => passes(row, selectedId) < passes(row, base),
    improved: (row) => passes(row, selectedId) > passes(row, base),
    unsteady: (row) =>
      passes(row, selectedId) < (row.trials[selectedId] ?? []).length,
  };
  const single = data.purpose === 'eval' && data.variants.length === 1;
  const filters: Array<[CaseFilter, string]> = single
    ? [
        ['unsteady', 'Needs attention'],
        ['all', 'All'],
      ]
    : [
        ['all', 'All'],
        ['regressed', 'Worse'],
        ['improved', 'Better'],
        ['unsteady', 'Not fully passing'],
      ];
  const sections = sectionsOf(data);
  const openRow = open
    ? data.cases.find((c) => c.id === open.caseId)
    : undefined;
  let shown = 0;

  return (
    <section aria-labelledby="exp-cases-h" className="grid gap-2">
      <h2 id="exp-cases-h" className="text-lg font-semibold">
        Case by case
      </h2>
      <p className="text-sm text-muted-foreground">
        {single ? (
          <>Each dot is one trial. Select a case to read its trials.</>
        ) : (
          <>
            Each dot is one trial. Filters and arrows compare{' '}
            <span className="font-mono">{selectedName}</span> with the baseline.
            Select a cell to read its trials.
          </>
        )}
      </p>
      <div
        className="flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label="Case filters"
      >
        <div
          className="inline-flex overflow-hidden rounded-md border"
          role="group"
          aria-label="Show cases"
        >
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => onFilter(id)}
              className={`border-r px-3 py-1.5 text-sm last:border-r-0 ${
                filter === id ? 'bg-primary/10 font-semibold' : 'hover:bg-muted'
              }`}
            >
              {label}{' '}
              <span className="font-mono text-muted-foreground">
                {data.cases.filter(tests[id]).length}
              </span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={sortByChange}
          onClick={() => setSortByChange((s) => !s)}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {sortByChange ? 'Sort: biggest drop first' : 'Sort: dataset order'}
        </button>
      </div>
      <div
        className="flex flex-wrap gap-4 text-xs text-muted-foreground"
        aria-hidden="true"
      >
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm border border-green-600 bg-green-500/10" />{' '}
          passed every trial
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm border border-amber-600 bg-amber-500/10" />{' '}
          passed some
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm border border-red-600 bg-red-500/10" />{' '}
          {single
            ? 'failed every trial'
            : 'failed every trial, or worse than the baseline'}
        </span>
        {!single && (
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded-sm border bg-muted/70" /> baseline
            (the reference)
          </span>
        )}
        {!single && (
          <>
            <span>
              <b className="text-green-600 dark:text-green-400">▲</b> passes
              more trials than the baseline
            </span>
            <span>
              <b className="text-red-600 dark:text-red-400">▼</b> passes fewer
            </span>
          </>
        )}
      </div>
      <div className="max-h-[720px] overflow-auto rounded-lg border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>
              <th
                scope="col"
                className="px-3 py-2 text-left align-bottom font-semibold"
              >
                Case
              </th>
              {data.variants.map((v) => (
                <th
                  key={v.id}
                  scope="col"
                  className={`min-w-[104px] px-2 py-2 text-center align-bottom font-semibold ${
                    v.id === selectedId ? 'bg-primary/10 text-foreground' : ''
                  }`}
                >
                  <span className="block font-mono">
                    {variantName(data, v)}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal">
                    {single ? (
                      'trials'
                    ) : v.id === base ? (
                      'reference'
                    ) : (
                      <CaseCounts
                        up={v.improvedCaseIds.length}
                        down={v.regressedCaseIds.length}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              let rows = section.rows.filter(tests[filter]);
              if (rows.length === 0) return null;
              if (sortByChange) {
                const delta = (r: VariantComparisonCase) =>
                  passes(r, selectedId) - passes(r, base);
                rows = [...rows].sort((a, b) => delta(a) - delta(b));
              }
              shown += rows.length;
              return (
                <React.Fragment key={section.key}>
                  <tr className="border-t bg-muted/50">
                    <td className="px-3 py-2 font-semibold">
                      {section.label}{' '}
                      <span className="font-normal text-muted-foreground">
                        · {section.rows.length}{' '}
                        {section.rows.length === 1 ? 'case' : 'cases'} ·{' '}
                        {section.hint}
                      </span>
                    </td>
                    {data.variants.map((v) => {
                      const rate = section.rate(v);
                      return (
                        <td
                          key={v.id}
                          className="px-2 py-2 text-center font-mono text-xs text-muted-foreground"
                        >
                          {rate !== undefined ? pct(rate) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="min-w-[220px] px-3 py-2">
                        <div className="font-mono font-semibold">{row.id}</div>
                        {row.input && (
                          <div className="text-muted-foreground">
                            “{row.input}”
                          </div>
                        )}
                        {row.expectedTools && (
                          <div className="font-mono text-xs text-muted-foreground/80">
                            expects {row.expectedTools.join(', ')}
                          </div>
                        )}
                      </td>
                      {data.variants.map((v) => (
                        <Cell
                          key={v.id}
                          row={row}
                          variant={v}
                          data={data}
                          selected={v.id === selectedId}
                          onOpen={(button) => {
                            lastButton.current = button;
                            setOpen({
                              caseId: row.id,
                              variantId: v.id === base ? selectedId : v.id,
                            });
                          }}
                        />
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
            {shown === 0 && (
              <tr>
                <td
                  colSpan={data.variants.length + 1}
                  className="p-6 text-center text-muted-foreground"
                >
                  No cases match this filter for {selectedName}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {open && openRow && (
        <AttemptDialog
          data={data}
          row={openRow}
          variantId={open.variantId}
          onClose={() => {
            setOpen(null);
            lastButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}
