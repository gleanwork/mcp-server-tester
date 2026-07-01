import React from 'react';
import { FlaskConical } from 'lucide-react';
import type { MCPVariantExperimentData } from '../../types';
import { rateColorClass } from '../../utils';

const pct = (n: number) => `${Math.round(n * 100)}%`;

const RECO_STYLE: Record<string, string> = {
  apply:
    'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  reject: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  inconclusive: 'bg-muted text-muted-foreground border-border',
};

/**
 * Compact summary of a runVariantExperiment run: how tool-metadata wording was
 * optimized from the baseline to the winning variant, round by round.
 */
export function VariantExperimentCard({
  data,
}: {
  data: MCPVariantExperimentData;
}) {
  const delta = data.bestValue - data.baselineValue;
  const reco = data.recommendation ?? 'inconclusive';

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical
            size={16}
            className="text-blue-600 dark:text-blue-400"
          />
          <h3 className="font-semibold">Variant Experiment</h3>
          <span className="text-xs text-muted-foreground">
            optimizing {data.metric}
          </span>
        </div>
        <span
          className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${
            RECO_STYLE[reco] ?? RECO_STYLE.inconclusive
          }`}
        >
          {reco}
        </span>
      </div>

      <div className="mb-3 flex items-baseline gap-2">
        <span className="tabular-nums text-muted-foreground">
          {pct(data.baselineValue)}
        </span>
        <span className="text-muted-foreground">→</span>
        <span
          className={`text-xl font-bold tabular-nums ${rateColorClass(data.bestValue)}`}
        >
          {pct(data.bestValue)}
        </span>
        {delta > 0 && (
          <span className="text-sm font-semibold text-green-600 dark:text-green-400">
            +{pct(delta)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {data.metric} · {data.rounds.length} round
          {data.rounds.length !== 1 ? 's' : ''}
        </span>
      </div>

      {data.rounds.length > 0 && (
        <ol className="space-y-1 text-sm">
          {data.rounds.map((r) => (
            <li key={r.round} className="flex items-center gap-2">
              <span className="w-8 tabular-nums text-muted-foreground">
                #{r.round}
              </span>
              <span
                className={`w-12 font-medium tabular-nums ${rateColorClass(r.metricValue)}`}
              >
                {pct(r.metricValue)}
              </span>
              <span className="truncate font-mono text-xs">{r.variantId}</span>
              {r.disqualified && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  regressed
                </span>
              )}
              {r.variantId === data.winnerVariantId && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  ✓ winner
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
