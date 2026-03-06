import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { MCPEvalHistoricalSummary } from '../../types';

// Recharts props cannot use CSS variables — these mirror the design token values:
// green-500 (pass rate line) and slate-400 (reference line/grid).
// Update these if the theme tokens change.
// Dark mode note: Recharts renders in SVG; these are static regardless of theme.
const PASS_COLOR = '#22c55e';
const MUTED_COLOR = '#94a3b8';

// Module-level Recharts configuration constants — defined outside the component
// so they are never recreated on re-render.
const CHART_MARGIN = { top: 4, right: 16, left: 0, bottom: 0 };
const AXIS_TICK_STYLE = { fontSize: 12 };
const LINE_DOT_STYLE = { fill: PASS_COLOR, r: 4 };
const LINE_ACTIVE_DOT_STYLE = { r: 5 };

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatPercent(v: number): string {
  return `${v}%`;
}

interface ChartDataPoint {
  label: string;
  value: number;
  timestamp: string;
  passed: number;
  total: number;
}

type CustomTooltipPayload = TooltipContentProps<number, string> & {
  payload?: Array<{ payload: ChartDataPoint }>;
};

function CustomTooltip({ active, payload, label }: CustomTooltipPayload) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const data = payload[0]?.payload;
  if (!data) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm text-sm">
      <p className="font-medium text-foreground mb-1">{label}</p>
      <p className="text-green-600 dark:text-green-400">
        Pass Rate: {data.value}%
      </p>
      <p className="text-muted-foreground">
        {data.passed} / {data.total} passed
      </p>
    </div>
  );
}

interface TrendChartProps {
  historical: MCPEvalHistoricalSummary[];
}

export function TrendChart({ historical }: TrendChartProps) {
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const chartData = useMemo(
    () =>
      historical.map((h) => ({
        label: formatDate(h.timestamp),
        value: Math.round(h.passRate * 100),
        timestamp: h.timestamp,
        passed: h.passed,
        total: h.total,
      })),
    [historical]
  );

  if (chartData.length < 2) {
    return null;
  }

  const trendSummary =
    chartData.length > 0
      ? `Pass rate trend: ${chartData.map((d) => `${d.value}% on ${d.label}`).join(', ')}`
      : 'No historical data';

  return (
    <div
      className="rounded-lg border bg-card p-4 shadow-sm"
      role="img"
      aria-label={trendSummary}
    >
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Pass Rate Trend
      </span>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={CHART_MARGIN}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              strokeOpacity={0.1}
            />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK_STYLE}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tickFormatter={formatPercent}
              tick={AXIS_TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={42}
            />
            <Tooltip content={CustomTooltip} />
            <ReferenceLine
              y={80}
              stroke={MUTED_COLOR}
              strokeDasharray="4 4"
              strokeOpacity={0.7}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={PASS_COLOR}
              strokeWidth={2}
              dot={LINE_DOT_STYLE}
              activeDot={LINE_ACTIVE_DOT_STYLE}
              isAnimationActive={!prefersReducedMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
