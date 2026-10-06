import React, { useState } from 'react';
import type { MCPComparisonData, MCPVariantExperimentData } from '../../types';
import { Recommendation } from './Recommendation';
import { VariantTable } from './VariantTable';
import { ChangeDiff } from './ChangeDiff';
import { CaseGrid, type CaseFilter } from './CaseGrid';
import { TrialFailures } from './TrialFailures';
import { changedThing, variantName } from './format';

const REASON_TEXT: Record<string, string> = {
  'threshold-met': 'reached its target',
  'no-improvement': 'a round stopped improving',
  'max-rounds': 'ran every round it was allowed',
  'no-variants': 'there were no variants to try',
};

function attemptsText(data: MCPComparisonData): string {
  const { trialsPerCase: max, minTrialsPerCase: min } = data;
  if (min === max) return `${max} ${max === 1 ? 'trial' : 'trials'} per case`;
  return `${min}–${max} trials per case`;
}

/**
 * The report for a tool optimization: the answer first, then each variant
 * compared with the current metadata, what changed, every case, and why
 * trials failed. Renders `MCPComparisonData` as computed by the
 * library; it calculates nothing itself.
 */
export function ComparisonView({
  experiment,
  data,
}: {
  experiment: MCPVariantExperimentData;
  data: MCPComparisonData;
}) {
  const candidates = data.variants.filter((v) => v.id !== data.baselineId);
  const [selectedId, setSelectedId] = useState(
    data.recommendedId ?? candidates[0]?.id ?? data.baselineId
  );
  const [filter, setFilter] = useState<CaseFilter>('all');
  const { what, tools } = changedThing(data);
  const selected = data.variants.find((v) => v.id === selectedId);
  const singular = what.replace(/s$/, '');

  return (
    <div className="grid max-w-[1120px] gap-12">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {tools.length === 1 ? (
            <>
              Testing new {what} for the{' '}
              <code className="font-mono text-xl">{tools[0]}</code> tool
            </>
          ) : tools.length > 1 ? (
            <>
              Testing new {what} for {tools.length} tools
            </>
          ) : (
            <>Tool optimization</>
          )}
        </h1>
        <p className="max-w-[70ch] text-[15px] text-muted-foreground">
          We tried {candidates.length}{' '}
          {candidates.length === 1 ? 'variant' : 'variants'} against the current{' '}
          {singular}. Each ran the same {data.cases.length} test cases,{' '}
          {attemptsText(data)}.
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Run details
          </summary>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Ranked by</dt>
            <dd>
              <span className="font-mono">{experiment.metric}</span>, without
              held-out cases
            </dd>
            <dt className="text-muted-foreground">Regression check</dt>
            <dd className="font-mono">{data.regressionCheck}</dd>
            <dt className="text-muted-foreground">Groups</dt>
            <dd>
              {data.grouping === 'declared' ? (
                <>
                  cases tagged{' '}
                  <span className="font-mono">{data.regressionTag}</span> are
                  regression cases
                </>
              ) : data.variantsTried > 0 ? (
                <>from an extra baseline run (no case was tagged)</>
              ) : (
                <>none (no variants ran)</>
              )}
            </dd>
            <dt className="text-muted-foreground">Variants tried</dt>
            <dd>
              {data.variantsTried}; clearly better needs p below{' '}
              {Number(
                (data.alpha / Math.max(1, data.variantsTried)).toPrecision(2)
              )}
            </dd>
            <dt className="text-muted-foreground">Rounds</dt>
            <dd>
              {experiment.rounds.length}; stopped because{' '}
              {REASON_TEXT[experiment.reason] ?? experiment.reason}
            </dd>
            <dt className="text-muted-foreground">Cases</dt>
            <dd>
              {data.cases.filter((c) => c.group === 'capability').length}{' '}
              capability,{' '}
              {data.cases.filter((c) => c.group === 'regression').length}{' '}
              regression; {data.cases.filter((c) => c.heldOut).length} tagged “
              {data.heldOutTag}”
            </dd>
          </dl>
        </details>
      </header>

      <section aria-labelledby="exp-result-h" className="grid gap-2">
        <h2
          id="exp-result-h"
          className="text-sm font-semibold text-muted-foreground"
        >
          Result
        </h2>
        <Recommendation
          data={data}
          what={singular}
          metric={experiment.metric}
          onShowUnsteady={() => {
            if (data.recommendedId) setSelectedId(data.recommendedId);
            setFilter('unsteady');
            document
              .getElementById('exp-cases-h')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      </section>

      {candidates.length > 0 && (
        <VariantTable
          data={data}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {selected && selected.id !== data.baselineId && (
        <ChangeDiff
          variantLabel={variantName(data, selected)}
          changes={selected.toolChanges}
        />
      )}

      <CaseGrid
        data={data}
        selectedId={selectedId}
        filter={filter}
        onFilter={setFilter}
      />

      <TrialFailures data={data} selectedId={selectedId} />
    </div>
  );
}
