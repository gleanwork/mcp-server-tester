import React, { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import type { EvalCaseResult } from '../../types';

interface ToolStats {
  toolName: string;
  cases: number;
  passed: number;
  passRate: number;
  avgDurationMs: number;
  avgRecall: number | null;
  avgPrecision: number | null;
}

function computeByTool(results: EvalCaseResult[]): ToolStats[] {
  const byTool = new Map<string, EvalCaseResult[]>();

  for (const result of results) {
    const existing = byTool.get(result.toolName);
    if (existing) {
      existing.push(result);
    } else {
      byTool.set(result.toolName, [result]);
    }
  }

  const stats: ToolStats[] = [];

  for (const [toolName, toolResults] of byTool.entries()) {
    const cases = toolResults.length;
    const passed = toolResults.filter((r) => r.pass).length;
    const passRate = cases > 0 ? passed / cases : 0;
    const avgDurationMs =
      toolResults.reduce((sum, r) => sum + r.durationMs, 0) / cases;

    const recallValues = toolResults
      .filter((r) => r.toolRecall !== undefined)
      .map((r) => r.toolRecall as number);
    const avgRecall =
      recallValues.length > 0
        ? recallValues.reduce((sum, v) => sum + v, 0) / recallValues.length
        : null;

    const precisionValues = toolResults
      .filter((r) => r.toolPrecision !== undefined)
      .map((r) => r.toolPrecision as number);
    const avgPrecision =
      precisionValues.length > 0
        ? precisionValues.reduce((sum, v) => sum + v, 0) /
          precisionValues.length
        : null;

    stats.push({
      toolName,
      cases,
      passed,
      passRate,
      avgDurationMs,
      avgRecall,
      avgPrecision,
    });
  }

  return stats.sort((a, b) => a.passRate - b.passRate);
}

function passRateColor(rate: number): string {
  if (rate >= 0.8) return 'text-green-600 dark:text-green-400';
  if (rate < 0.6) return 'text-red-600 dark:text-red-400';
  return 'text-amber-600 dark:text-amber-400';
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatRatio(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function ByToolTable({
  results,
  isExpanded,
}: {
  results: EvalCaseResult[];
  isExpanded: boolean;
}) {
  const toolStats = useMemo(() => computeByTool(results), [results]);

  const distinctTools = useMemo(
    () => new Set(results.map((r) => r.toolName)).size,
    [results]
  );

  // Always use a neutral blue — the panel is a data view, not a status indicator.
  // Individual rows already color-code pass rates; the header doesn't need to warn.
  const headerColor = 'bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/15';
  const badgeColor = 'text-blue-600 dark:text-blue-400';

  if (distinctTools < 2) return null;

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className={`px-4 py-3 border-b ${headerColor}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="font-semibold">Performance by Tool</h3>
          </div>
          <span className={`text-sm font-medium ${badgeColor}`}>
            {toolStats.length} tools
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 sticky top-0">
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Tool Name
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Cases
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Pass Rate
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Avg Duration
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Recall
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Precision
                </th>
              </tr>
            </thead>
            <tbody>
              {toolStats.map((stat, idx) => (
                <tr
                  key={stat.toolName}
                  className={`border-b last:border-0 ${idx % 2 === 0 ? '' : 'bg-muted/10'} hover:bg-muted/20 transition-colors`}
                >
                  <td className="px-6 py-3 font-mono text-xs font-medium text-foreground">
                    {stat.toolName}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {stat.cases}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-semibold ${passRateColor(stat.passRate)}`}
                  >
                    {(stat.passRate * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {formatMs(stat.avgDurationMs)}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {formatRatio(stat.avgRecall)}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {formatRatio(stat.avgPrecision)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
