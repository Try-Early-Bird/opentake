import {usePortfolioRenderProbe} from '../portfolio-render-probe';
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartWatermark } from './ChartWatermark';
import { chartTradingDay } from '../market-series';
import type { PortfolioHistoryPoint, PortfolioRange } from '../portfolio-history';
interface ChartOverlay { key: string; color: string; points: { timestamp: number; value: number }[] }

type ChartPoint = { timestamp: number; value: number; [overlay: `overlay:${string}`]: number | null };

export interface PortfolioHoverPoint {
  timestamp: number;
  value: number;
  /** Overlay values at the same point, by overlay key; null where an overlay has no value yet. */
  overlays?: Record<string, number | null>;
}

function currencyFormatter(currency: string, maximumFractionDigits: number): Intl.NumberFormat {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits,
  });
}

// The desktop dashboard chart matches the web app's treatment.
export function portfolioChartValueTicks(data: readonly ChartPoint[]): number[] {
  if (data.length === 0) return [];
  const values = data.map((point) => point.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const range = dataMax - dataMin;
  if (range === 0) {
    const buffer = Math.max(Math.abs(dataMin) * 0.01, 1);
    return Array.from({ length: 6 }, (_, index) => dataMin - buffer + ((buffer * 2) / 5) * index);
  }

  const buffer = range * 0.15;
  let minimum = dataMin - buffer;
  let maximum = dataMax + buffer;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(Math.abs(minimum), Math.abs(maximum), 1)));
  const roundingFactor = magnitude / 20;
  minimum = Math.floor(minimum / roundingFactor) * roundingFactor;
  maximum = Math.ceil(maximum / roundingFactor) * roundingFactor;
  const tickSize = (maximum - minimum) / 5;
  return Array.from({ length: 6 }, (_, index) => minimum + tickSize * index);
}

export function portfolioChartTimeTicks(
  data: readonly ChartPoint[],
  range: PortfolioRange,
): number[] {
  if (data.length === 0) return [];
  const minimum = data[0]?.timestamp ?? 0;
  const maximum = data.at(-1)?.timestamp ?? minimum;
  if (minimum === maximum) return [minimum];

  if (range === '1d') {
    // Every 4 hours across the fixed calendar-day axis.
    const ticks: number[] = [];
    for (let tick = minimum; tick <= maximum; tick += 4 * 60 * 60 * 1_000) ticks.push(tick);
    return ticks;
  }

  const desiredTickCount = range === '1w' ? 7 : range === '1m' ? 5 : 6;
  return Array.from({ length: desiredTickCount }, (_, index) =>
    Math.round(minimum + ((maximum - minimum) / (desiredTickCount - 1)) * index));
}

function hoverTimeLabel(timestamp: number, range: PortfolioRange): string {
  const date = new Date(timestamp);
  if (range === '1d') return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (range === '1w') {
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// Anchors labels near the left edge to "start" so the first time tick isn't
// clipped by the SVG boundary.
function XAxisTick({ x, y, payload, formatter }: {
  x?: number;
  y?: number;
  payload?: { value: number };
  formatter: (value: number) => string;
}): React.JSX.Element | null {
  if (x === undefined || y === undefined || payload === undefined) return null;
  return (
    <text x={x} y={y} dy={12} textAnchor={x < 48 ? 'start' : 'middle'} fill="#666" fontSize={11}>
      {formatter(payload.value)}
    </text>
  );
}

export function PortfolioChart({
  points,
  currency,
  range,
  onHoverPoint,
  overlays = [],
  tickFormatter,
  continuous = false,
}: {
  continuous?: boolean;
  points: readonly PortfolioHistoryPoint[];
  currency: string;
  range: PortfolioRange;
  onHoverPoint?: (point: PortfolioHoverPoint | null) => void;
  /** Extra lines on the main series' timestamps, e.g. other members rebased to the same start. */
  overlays?: readonly ChartOverlay[];
  /** Y-axis labels; the compact currency by default. */
  tickFormatter?: (value: number) => string;
}): React.JSX.Element {
  usePortfolioRenderProbe(range,points.length);
  const allPoints = useMemo(() => {
    const main: ChartPoint[] = points.map((point) => ({
      timestamp: new Date(point.observedAt).getTime(),
      value: Number(point.totalAssetValue),
    })).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
    // Overlays join by timestamp; missing timestamps draw as gaps.
    for (const overlay of overlays) {
      const byTimestamp = new Map(overlay.points.map((point) => [point.timestamp, point.value]));
      for (const point of main) point[`overlay:${overlay.key}`] = byTimestamp.get(point.timestamp) ?? null;
    }
    return main;
  }, [points, overlays]);
  // Robinhood's 1D chart is the Eastern calendar day on a fixed midnight-to-
  // midnight axis, drawn only as far as now, with the previous regular close
  // as a dotted baseline. The API series starts at that close so the first
  // point is the baseline; only points inside the day are drawn.
  const day = useMemo(() => {
    if (range !== '1d' || continuous) return null;
    const last = allPoints.at(-1);
    return last === undefined ? null : chartTradingDay(last.timestamp);
  }, [range, allPoints, continuous]);
  const data = useMemo(
    () => (day === null ? allPoints : allPoints.filter((point) => point.timestamp >= day.dayStartMs)),
    [allPoints, day],
  );
  const baseline = day === null ? null : allPoints[0]?.value ?? null;
  const xDomain: [number, number] | undefined = day !== null ? [day.dayStartMs, day.dayEndMs] : continuous && data.length > 1 ? [data[0].timestamp, data.at(-1)!.timestamp] : undefined;
  // Overlay values widen the y-range so no line clips.
  const yAxisTicks = useMemo(() => portfolioChartValueTicks([
    ...data,
    ...(baseline === null ? [] : [{ timestamp: 0, value: baseline }]),
    ...overlays.flatMap((overlay) => overlay.points.map((point) => ({ timestamp: point.timestamp, value: point.value }))),
  ]), [data, baseline, overlays]);
  const xAxisTicks = useMemo(() => xDomain === undefined
    ? portfolioChartTimeTicks(data, range)
    : portfolioChartTimeTicks([{ timestamp: xDomain[0], value: 0 }, { timestamp: xDomain[1], value: 0 }], range), [data, range, xDomain]);
  const compactCurrency = useMemo(() => currencyFormatter(currency, 0), [currency]);

  return (
    <div className="relative h-full min-h-0 w-full" role="img" aria-label="Portfolio value over time">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 24, right: 0, left: 0, bottom: 15 }}
          onMouseMove={(state) => {
            const index = Number(state.activeTooltipIndex);
            const point = state.isTooltipActive && Number.isInteger(index) ? data[index] : undefined;
            onHoverPoint?.(point === undefined ? null : {
              timestamp: point.timestamp,
              value: point.value,
              overlays: Object.fromEntries(overlays.map((overlay) => [overlay.key, point[`overlay:${overlay.key}`] ?? null])),
            });
          }}
          onMouseLeave={() => onHoverPoint?.(null)}
        >
          <CartesianGrid
            strokeDasharray="2 2"
            stroke="#666"
            opacity={0.2}
            vertical
            verticalCoordinatesGenerator={({ xAxis }) => {
              if (xAxis?.scale === undefined) return [];
              return xAxisTicks.slice(1).flatMap((tick) => {
                const coordinate = xAxis.scale?.map(tick);
                return coordinate === undefined ? [] : [coordinate];
              });
            }}
          />
          <XAxis
            dataKey="timestamp"
            {...(xDomain === undefined ? {} : { type: 'number' as const, domain: xDomain })}
            ticks={xAxisTicks}
            interval={0}
            minTickGap={50}
            tick={(
              <XAxisTick
                formatter={(value: number) => range === '1d'
                  ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              />
            )}
            stroke="#666"
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={yAxisTicks.length === 0 ? ['dataMin', 'dataMax'] : [yAxisTicks[0]!, yAxisTicks.at(-1)!]}
            ticks={yAxisTicks}
            tickCount={6}
            interval="equidistantPreserveStart"
            stroke="#666"
            fontSize={11}
            tickFormatter={tickFormatter ?? ((value: number) => compactCurrency.format(value))}
            tickLine={false}
            axisLine={false}
            orientation="right"
          />
          {/* Robinhood-style hover: only the time floats above the cursor line;
              the hovered value is reflected in the dashboard header instead. */}
          <Tooltip
            position={{ y: 0 }}
            offset={0}
            isAnimationActive={false}
            cursor={{ stroke: '#666', strokeWidth: 1 }}
            content={({ active, label, coordinate }) => {
              if (active !== true || label === undefined) return null;
              return (
                <div
                  className="whitespace-nowrap text-[11px] font-medium text-muted-foreground"
                  style={{ transform: `translateX(max(-50%, ${8 - (coordinate?.x ?? 0)}px))` }}
                >
                  {hoverTimeLabel(Number(label), range)}
                </div>
              );
            }}
          />
          {baseline !== null && (
            <ReferenceLine y={baseline} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 4" />
          )}
          <Line
            type="monotone"
            dataKey="value"
            name="Portfolio value"
            stroke="#10A081"
            strokeWidth={2}
            dot={data.length === 1}
            activeDot={{ r: 6, fill: '#10A081', stroke: '#fff', strokeWidth: 2 }}
            connectNulls
            isAnimationActive={false}
          />
          {overlays.map((overlay) => (
            <Line
              key={overlay.key}
              type="monotone"
              dataKey={`overlay:${overlay.key}`}
              stroke={overlay.color}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: overlay.color, stroke: '#fff', strokeWidth: 1.5 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <ChartWatermark className="bottom-12" />
    </div>
  );
}
