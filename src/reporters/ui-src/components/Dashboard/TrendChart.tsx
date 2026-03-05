import React from 'react';
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
import type { MCPEvalHistoricalSummary } from '../../types';

interface TrendChartProps {
  historical: MCPEvalHistoricalSummary[];
}

interface ChartDataPoint {
  date: string;
  passRate: number;
  passed: number;
  total: number;
}

interface TooltipPayloadEntry {
  value: number;
  payload: ChartDataPoint;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
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
        Pass Rate: {data.passRate.toFixed(1)}%
      </p>
      <p className="text-muted-foreground">
        {data.passed} / {data.total} passed
      </p>
    </div>
  );
}

export function TrendChart({ historical }: TrendChartProps) {
  if (historical.length < 2) {
    return null;
  }

  const chartData: ChartDataPoint[] = historical.map((entry) => ({
    date: formatDate(entry.timestamp),
    passRate: entry.passRate * 100,
    passed: entry.passed,
    total: entry.total,
  }));

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Pass Rate Trend
      </span>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart
            data={chartData}
            margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              strokeOpacity={0.1}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={42}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={80}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
            />
            <Line
              type="monotone"
              dataKey="passRate"
              stroke="#22c55e"
              strokeWidth={2}
              dot={{ fill: '#22c55e', r: 4 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
