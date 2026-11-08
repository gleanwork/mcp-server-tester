import { useEffect, useRef, useState } from 'react';
import type { HistoryRun, HistoryVariant } from '../../types';
import {
  completeFor,
  dateText,
  formatValue,
  reportHref,
  shortId,
  type EraStart,
  type MetricDef,
} from './historyData';

const HEIGHT = 190;
const PAD = { top: 18, right: 22, bottom: 26, left: 46 };

interface Point {
  run: HistoryRun;
  variant: HistoryVariant;
  x: number;
  value: number;
  band?: [number, number];
  secondary?: number;
}

interface Hover {
  point: Point;
  left: number;
  top: number;
}

/** The chart's width: its container's, kept up to date. */
function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setWidth(Math.max(240, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round numbers for a value axis from 0 to `max`. */
function ticks(max: number, format: MetricDef['format']): number[] {
  if (format === 'pct') return [0, 0.25, 0.5, 0.75, 1];
  if (max <= 0) return [0];
  const step = 10 ** Math.floor(Math.log10(max / 3));
  const nice = [1, 2, 2.5, 5, 10]
    .map((m) => m * step)
    .find((s) => max / s <= 4)!;
  return Array.from({ length: Math.floor(max / nice) + 1 }, (_, i) => i * nice);
}

/**
 * One metric over the eval's runs: a line per variant, broken where the
 * variant's era starts, a band for a 95% range, and a dashed line where an
 * era starts. A point links to its run's report.
 */
export function TrendChart({
  metric,
  points,
  variants,
  colors,
  eras,
}: {
  metric: MetricDef;
  /** The runs on the lines, oldest first. */
  points: HistoryRun[];
  /** The variants shown. */
  variants: string[];
  colors: Record<string, string>;
  eras: EraStart[];
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const xOf = (index: number) =>
    PAD.left +
    (points.length === 1
      ? plotWidth / 2
      : (index / (points.length - 1)) * plotWidth);
  const series = variants.map((name) => ({
    name,
    points: points.flatMap((run, index): Point[] => {
      const variant = run.variants.find((v) => v.name === name);
      const value = variant ? metric.value(variant) : undefined;
      if (!variant || value === undefined) return [];
      const band = metric.band?.(variant);
      const secondary = metric.secondary?.(variant);
      return [
        {
          run,
          variant,
          x: xOf(index),
          value,
          ...(band ? { band } : {}),
          ...(secondary !== undefined ? { secondary } : {}),
        },
      ];
    }),
  }));
  const all = series.flatMap((s) =>
    s.points.flatMap((p) => [p.value, p.band?.[1] ?? 0, p.secondary ?? 0])
  );
  const max = metric.format === 'pct' ? 1 : Math.max(...all, 0) * 1.12 || 1;
  const yTicks = ticks(max, metric.format);
  const top = metric.format === 'pct' ? 1 : (yTicks[yTicks.length - 1] ?? max);
  const domain = Math.max(top, max);
  const yOf = (value: number) =>
    PAD.top + plotHeight - (Math.min(value, domain) / domain) * plotHeight;
  /** Consecutive points of one era, joined; a new era starts a new line. */
  const segments = (list: Point[]) => {
    const out: Point[][] = [];
    for (const point of list) {
      const last = out[out.length - 1];
      if (last && last[last.length - 1]!.variant.era === point.variant.era)
        last.push(point);
      else out.push([point]);
    }
    return out;
  };
  const line = (list: Point[], value: (p: Point) => number) =>
    list
      .map(
        (p, i) =>
          `${i ? 'L' : 'M'}${p.x.toFixed(1)},${yOf(value(p)).toFixed(1)}`
      )
      .join(' ');
  const band = (list: Point[]) => {
    const ranged = list.filter((p) => p.band);
    if (ranged.length < 2) return '';
    return `${ranged.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${yOf(p.band![1]).toFixed(1)}`).join(' ')} ${[
      ...ranged,
    ]
      .reverse()
      .map((p) => `L${p.x.toFixed(1)},${yOf(p.band![0]).toFixed(1)}`)
      .join(' ')} Z`;
  };
  const eraX = eras.flatMap((era) => {
    const index = points.findIndex((run) => run.runId === era.runId);
    if (index <= 0) return [];
    return [{ ...era, x: (xOf(index - 1) + xOf(index)) / 2, index }];
  });
  // Label every run when they fit, else every few.
  const every = Math.max(1, Math.ceil((points.length * 54) / plotWidth));
  const empty = series.every((s) => s.points.length === 0);

  return (
    <figure className="grid min-w-0 gap-1 rounded-lg border bg-card p-3">
      <figcaption className="grid">
        <span className="text-sm font-semibold">{metric.title}</span>
        <span className="text-xs text-muted-foreground">{metric.subtitle}</span>
      </figcaption>
      <div
        ref={ref}
        className="relative min-w-0"
        onMouseLeave={() => setHover(null)}
      >
        {empty ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No variant shown has this measurement.
          </p>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${metric.title} over ${points.length} runs`}
            className="block text-muted-foreground"
          >
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={yOf(tick)}
                  y2={yOf(tick)}
                  stroke="currentColor"
                  strokeOpacity={0.15}
                />
                <text
                  x={PAD.left - 6}
                  y={yOf(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={10}
                  fill="currentColor"
                >
                  {formatValue(tick, metric.format)}
                </text>
              </g>
            ))}
            {points.map((run, index) =>
              index % every === 0 || index === points.length - 1 ? (
                <text
                  key={run.runId}
                  x={xOf(index)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill="currentColor"
                >
                  {dateText(run.collectedAt)}
                </text>
              ) : null
            )}
            {eraX.map((era) => (
              <g key={era.runId}>
                <line
                  x1={era.x}
                  x2={era.x}
                  y1={PAD.top - 6}
                  y2={PAD.top + plotHeight}
                  stroke="currentColor"
                  strokeDasharray="4 3"
                  strokeOpacity={0.6}
                >
                  <title>
                    {`A new era starts: ${era.reasons
                      .map((r) =>
                        r.variant ? `${r.variant}: ${r.reason}` : r.reason
                      )
                      .join('; ')}`}
                  </title>
                </line>
                <text
                  x={era.x + 3}
                  y={PAD.top - 8}
                  fontSize={10}
                  fill="currentColor"
                >
                  {era.reasons.some((r) => r.variant === undefined)
                    ? 'new era'
                    : `new era: ${[...new Set(era.reasons.map((r) => r.variant))].join(', ')}`}
                </text>
              </g>
            ))}
            {series.map((s) =>
              segments(s.points).map((segment, i) => (
                <g key={`${s.name}-${i}`} color={colors[s.name]}>
                  {band(segment) && (
                    <path
                      d={band(segment)}
                      fill="currentColor"
                      fillOpacity={0.08}
                    />
                  )}
                  {segment.length > 1 && (
                    <path
                      d={line(segment, (p) => p.value)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    />
                  )}
                  {segment.length > 1 &&
                    segment.some((p) => p.secondary !== undefined) && (
                      <path
                        d={line(
                          segment.filter((p) => p.secondary !== undefined),
                          (p) => p.secondary!
                        )}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.25}
                        strokeDasharray="3 3"
                        strokeOpacity={0.8}
                      />
                    )}
                </g>
              ))
            )}
            {series.map((s) =>
              s.points.map((p) => {
                const complete = completeFor(p.run, p.variant);
                const regressed =
                  metric.marksRegressions && p.variant.sincePrevious?.regressed;
                return (
                  <a
                    key={`${s.name}-${p.run.runId}`}
                    href={reportHref(p.run)}
                    aria-label={`${s.name}, run ${shortId(p.run.runId)}: ${formatValue(p.value, metric.format)}. Open its report.`}
                    onMouseEnter={() =>
                      setHover({ point: p, left: p.x, top: yOf(p.value) })
                    }
                    onFocus={() =>
                      setHover({ point: p, left: p.x, top: yOf(p.value) })
                    }
                    onBlur={() => setHover(null)}
                  >
                    {regressed && (
                      <circle
                        cx={p.x}
                        cy={yOf(p.value)}
                        r={7}
                        fill="none"
                        stroke="#dc2626"
                        strokeWidth={2}
                      />
                    )}
                    <circle
                      cx={p.x}
                      cy={yOf(p.value)}
                      r={3.75}
                      // A CSS variable works in style, not in the attribute.
                      style={{
                        fill: complete ? colors[s.name] : 'hsl(var(--card))',
                      }}
                      stroke={colors[s.name]}
                      strokeWidth={2}
                    />
                    <circle
                      cx={p.x}
                      cy={yOf(p.value)}
                      r={10}
                      fill="transparent"
                      className="cursor-pointer"
                    />
                  </a>
                );
              })
            )}
          </svg>
        )}
        {hover && (
          <Tooltip
            hover={hover}
            width={width}
            metric={metric}
            color={colors[hover.point.variant.name] ?? 'currentColor'}
          />
        )}
      </div>
    </figure>
  );
}

function Tooltip({
  hover,
  width,
  metric,
  color,
}: {
  hover: Hover;
  width: number;
  metric: MetricDef;
  color: string;
}) {
  const { point } = hover;
  const right = hover.left > width / 2;
  const since = point.variant.sincePrevious;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-56 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
      style={{
        top: Math.max(0, hover.top - 12),
        ...(right
          ? { right: width - hover.left + 12 }
          : { left: hover.left + 12 }),
      }}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        <span className="font-mono">{point.variant.name}</span>
      </div>
      <div className="mt-1 font-mono text-muted-foreground">
        {shortId(point.run.runId)} · {dateText(point.run.collectedAt, true)}
      </div>
      <div className="mt-1">
        <span className="font-semibold">
          {formatValue(point.value, metric.format)}
        </span>
        {point.band && (
          <span className="text-muted-foreground">
            {' '}
            (likely {formatValue(point.band[0], metric.format)}–
            {formatValue(point.band[1], metric.format)})
          </span>
        )}
        {point.secondary !== undefined && (
          <span className="text-muted-foreground">
            {' '}
            · p95 {formatValue(point.secondary, metric.format)}
          </span>
        )}
      </div>
      {metric.marksRegressions && since?.change && (
        <div
          className={
            since.regressed ? 'mt-1 text-red-700 dark:text-red-400' : 'mt-1'
          }
        >
          Since {shortId(since.runId)}:{' '}
          {since.change.assessment === 'better'
            ? 'clearly better'
            : since.change.assessment === 'worse'
              ? 'clearly worse'
              : 'no clear change'}
        </div>
      )}
      {!completeFor(point.run, point.variant) && (
        <div className="mt-1 text-amber-700 dark:text-amber-300">
          Incomplete: some cases are short a trial or a verdict.
        </div>
      )}
      <div className="mt-1 text-muted-foreground">
        Click to open its report.
      </div>
    </div>
  );
}
