import React, { useMemo } from 'react';
import { BarChart3, FlaskConical } from 'lucide-react';
import type { EvalCaseResult } from '../../types';
import { rateColorClass } from '../../utils';

interface MetricsCardsProps {
  results: EvalCaseResult[];
  /** Controls which supplemental cards appear. 'overview' = totals only; 'eval' = accuracy + tool + regressions; 'test' = totals only */
  mode?: 'overview' | 'eval' | 'test';
}

interface MetricsSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgAccuracy?: number; // mean accuracy across multi-iteration cases
  totalIterations?: number; // total iterations run
}

function computeMetrics(results: EvalCaseResult[]): MetricsSummary {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  const multiIterResults = results.filter(
    (r) => r.assertionPassRate !== undefined
  );
  const avgAccuracy =
    multiIterResults.length > 0
      ? multiIterResults.reduce(
          (sum, r) => sum + (r.assertionPassRate ?? 0),
          0
        ) / multiIterResults.length
      : undefined;

  const totalIterations = results.reduce(
    (sum, r) => sum + (r.iterationResults?.length ?? 1),
    0
  );

  return {
    total,
    passed,
    failed,
    passRate: total > 0 ? passed / total : 0,
    avgAccuracy,
    totalIterations,
  };
}

interface ToolDiscoveryMetrics {
  meanRecall: number;
  count: number;
}

interface RegressionMetrics {
  regressions: number;
  fixes: number;
}

function computeToolDiscovery(
  results: EvalCaseResult[]
): ToolDiscoveryMetrics | null {
  const withRecall = results.filter((r) => r.toolRecall !== undefined);
  if (withRecall.length === 0) return null;
  const meanRecall =
    withRecall.reduce((sum, r) => sum + (r.toolRecall ?? 0), 0) /
    withRecall.length;
  return { meanRecall, count: withRecall.length };
}

function computeRegressions(
  results: EvalCaseResult[]
): RegressionMetrics | null {
  const withBaseline = results.filter((r) => r.baselinePass !== undefined);
  if (withBaseline.length === 0) return null;
  const regressions = withBaseline.filter(
    (r) => r.baselinePass === true && r.pass === false
  ).length;
  const fixes = withBaseline.filter(
    (r) => r.baselinePass === false && r.pass === true
  ).length;
  return { regressions, fixes };
}

export function MetricsCards({
  results,
  mode = 'overview',
}: MetricsCardsProps) {
  const overall = useMemo(() => computeMetrics(results), [results]);
  const toolDiscovery = useMemo(() => computeToolDiscovery(results), [results]);
  const regressionMetrics = useMemo(
    () => computeRegressions(results),
    [results]
  );
  const showEvalCards = mode === 'eval';

  const passRateColor = rateColorClass(overall.passRate);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3 shadow-sm">
      {/* Pass rate — always prominent */}
      <div className="flex items-baseline gap-1.5">
        <span className={`text-xl font-bold tabular-nums ${passRateColor}`}>
          {(overall.passRate * 100).toFixed(1)}%
        </span>
        <span className="text-xs text-muted-foreground">pass rate</span>
      </div>

      <Divider />

      {/* Regressions first — most actionable signal when present */}
      {showEvalCards && regressionMetrics !== null && (
        <>
          <Divider />
          <div className="flex items-center gap-2 text-sm">
            {regressionMetrics.regressions > 0 && (
              <span className="font-semibold text-red-600 dark:text-red-400">
                ▼ {regressionMetrics.regressions} regression
                {regressionMetrics.regressions !== 1 ? 's' : ''}
              </span>
            )}
            {regressionMetrics.fixes > 0 && (
              <span className="font-semibold text-green-600 dark:text-green-400">
                ▲ {regressionMetrics.fixes} fixed
              </span>
            )}
            {regressionMetrics.regressions === 0 &&
              regressionMetrics.fixes === 0 && (
                <span className="text-muted-foreground">
                  no changes vs baseline
                </span>
              )}
          </div>
        </>
      )}

      <Divider />

      {/* Compact pass count — X/Y passed */}
      <div className="flex items-center gap-1 text-sm">
        <span className="font-semibold text-green-600 dark:text-green-400">
          {overall.passed}
        </span>
        <span className="text-muted-foreground">/</span>
        <span className="text-muted-foreground">{overall.total} passed</span>
      </div>

      {/* Eval-specific stats */}
      {showEvalCards && overall.avgAccuracy !== undefined && (
        <>
          <Divider />
          <div className="flex items-baseline gap-1.5 text-sm">
            <span
              className={`font-semibold tabular-nums ${rateColorClass(overall.avgAccuracy)}`}
            >
              {(overall.avgAccuracy * 100).toFixed(1)}%
            </span>
            <span className="text-muted-foreground">avg pass rate</span>
            <span className="text-xs text-muted-foreground">
              ({overall.totalIterations} iterations)
            </span>
          </div>
        </>
      )}

      {showEvalCards && toolDiscovery !== null && (
        <>
          <Divider />
          <div className="flex items-baseline gap-1.5 text-sm">
            <span
              className={`font-semibold tabular-nums ${rateColorClass(toolDiscovery.meanRecall)}`}
            >
              {(toolDiscovery.meanRecall * 100).toFixed(0)}%
            </span>
            <span className="text-muted-foreground">tool discovery</span>
          </div>
        </>
      )}
    </div>
  );
}

function Divider() {
  return <div className="h-4 w-px shrink-0 bg-border" />;
}

interface SourceBreakdownProps {
  results: EvalCaseResult[];
}

export function SourceBreakdown({ results }: SourceBreakdownProps) {
  const { evals, tests } = useMemo(() => {
    const evalResults = results.filter((r) => r.source === 'eval');
    const testResults = results.filter((r) => r.source === 'test');
    return {
      evals: computeMetrics(evalResults),
      tests: computeMetrics(testResults),
    };
  }, [results]);

  if (evals.total === 0 && tests.total === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {tests.total > 0 && (
        <SourceBreakdownCard
          title="Test Suites"
          icon={<FlaskConical size={18} />}
          metrics={tests}
          accentColor="purple"
        />
      )}
      {evals.total > 0 && (
        <SourceBreakdownCard
          title="Eval Datasets"
          icon={<BarChart3 size={18} />}
          metrics={evals}
          accentColor="blue"
        />
      )}
    </div>
  );
}

interface SourceBreakdownCardProps {
  title: string;
  icon: React.ReactNode;
  metrics: MetricsSummary;
  accentColor: 'blue' | 'purple';
}

function SourceBreakdownCard({
  title,
  icon,
  metrics,
  accentColor,
}: SourceBreakdownCardProps) {
  const colorClasses = {
    blue: {
      border: 'border-l-blue-500',
      bg: 'bg-blue-500/5',
      icon: 'text-blue-600 dark:text-blue-400',
      title: 'text-blue-700 dark:text-blue-300',
    },
    purple: {
      border: 'border-l-purple-500',
      bg: 'bg-purple-500/5',
      icon: 'text-purple-600 dark:text-purple-400',
      title: 'text-purple-700 dark:text-purple-300',
    },
  };

  const colors = colorClasses[accentColor];

  return (
    <div
      className={`rounded-lg border border-l-4 ${colors.border} ${colors.bg} p-4 shadow-sm`}
    >
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <span className={colors.icon}>{icon}</span>
          <span className={`font-semibold ${colors.title}`}>{title}</span>
        </div>
        <div className="flex items-center gap-6 text-sm flex-wrap">
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Pass Rate
            </span>
            <span className={`font-bold ${rateColorClass(metrics.passRate)}`}>
              {(metrics.passRate * 100).toFixed(1)}%
            </span>
          </div>
          {metrics.avgAccuracy !== undefined && (
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground uppercase">
                Avg Pass Rate
              </span>
              <span
                className={`font-bold ${rateColorClass(metrics.avgAccuracy)}`}
              >
                {(metrics.avgAccuracy * 100).toFixed(1)}%
              </span>
            </div>
          )}
          {metrics.totalIterations !== undefined &&
            metrics.totalIterations > metrics.total && (
              <div className="flex flex-col items-center">
                <span className="text-xs text-muted-foreground uppercase">
                  Iterations
                </span>
                <span className="font-bold">{metrics.totalIterations}</span>
              </div>
            )}
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Cases
            </span>
            <span className="font-bold">{metrics.total}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Passed
            </span>
            <span className="font-bold text-green-600 dark:text-green-400">
              {metrics.passed}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase">
              Failed
            </span>
            <span
              className={`font-bold ${
                metrics.failed === 0
                  ? 'text-muted-foreground'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {metrics.failed}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
