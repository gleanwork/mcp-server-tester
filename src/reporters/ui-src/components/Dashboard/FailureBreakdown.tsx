import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { EvalCaseResult } from '../../types';
import type { ExpectationType } from '../../types';

interface FailureCount {
  type: ExpectationType;
  count: number;
}

function computeFailureCounts(results: EvalCaseResult[]): FailureCount[] {
  const counts = new Map<ExpectationType, number>();

  for (const result of results) {
    if (result.pass) continue;

    for (const [type, expectation] of Object.entries(result.expectations) as [
      ExpectationType,
      { pass: boolean },
    ][]) {
      if (expectation.pass === false) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
  }

  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export function FailureBreakdown({
  results,
  isExpanded,
}: {
  results: EvalCaseResult[];
  isExpanded: boolean;
}) {
  const failureCounts = useMemo(() => computeFailureCounts(results), [results]);
  const totalFailed = useMemo(
    () => results.filter((r) => !r.pass).length,
    [results]
  );

  if (totalFailed === 0) return null;

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-red-500/10 border-red-500/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
            <h3 className="font-semibold">Why Cases Fail</h3>
          </div>
          <span className="text-sm font-medium text-red-600 dark:text-red-400">
            {totalFailed} failure{totalFailed !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {failureCounts.map(({ type, count }) => (
              <span
                key={type}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
              >
                <span className="font-semibold">{type}</span>
                <span className="text-red-500 dark:text-red-500">
                  ({count})
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
