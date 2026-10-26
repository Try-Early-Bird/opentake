import { useId, useMemo } from 'react';

import {
  tradingDayForDate,
  type SeriesPoint,
  type SymbolSeries,
} from '../market-series';

// Robinhood-style position sparkline: a thin line in the change color with a
// dotted baseline (previous close for 1D, window open otherwise). For 1D the
// x-axis spans the full Eastern calendar day, so the line is drawn only as far
// as now and fills in as the day progresses; extended-hours segments render
// dimmed.

const WIDTH = 64;
const HEIGHT = 28;
const PADDING_Y = 2;

interface Segment {
  path: string;
  extended: boolean;
}

function buildSegments(
  points: readonly SeriesPoint[],
  xOf: (ms: number) => number,
  yOf: (value: number) => number,
): Segment[] {
  const segments: Segment[] = [];
  let current: { extended: boolean; coordinates: string[] } | null = null;
  let previous: { x: number; y: number } | null = null;
  for (const point of points) {
    const x = xOf(Date.parse(point.t));
    const y = yOf(Number(point.c));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const extended = point.s !== 'regular';
    if (current === null || current.extended !== extended) {
      if (current !== null) segments.push({ path: `M${current.coordinates.join(' L')}`, extended: current.extended });
      // Start the new segment from the previous point so the line is continuous.
      current = { extended, coordinates: previous === null ? [] : [`${previous.x},${previous.y}`] };
    }
    current.coordinates.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    previous = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  }
  if (current !== null && current.coordinates.length > 0) {
    segments.push({ path: `M${current.coordinates.join(' L')}`, extended: current.extended });
  }
  return segments;
}

export function Sparkline({
  series,
  positive,
  className,
}: {
  series: SymbolSeries;
  positive: boolean;
  className?: string;
}): React.JSX.Element {
  const clipId = useId();
  const { segments, baselineY, endDot } = useMemo(() => {
    const points = series.points;
    const values = points.map((point) => Number(point.c)).filter(Number.isFinite);
    const baseline = series.baseline === null ? null : Number(series.baseline.price);
    if (baseline !== null && Number.isFinite(baseline)) values.push(baseline);
    if (points.length === 0 || values.length === 0) {
      return { segments: [] as Segment[], baselineY: null as number | null, endDot: null as { x: number; y: number } | null };
    }
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const span = maximum - minimum || Math.max(Math.abs(maximum) * 0.01, 0.01);
    const yOf = (value: number): number =>
      HEIGHT - PADDING_Y - ((value - (maximum - span)) / span) * (HEIGHT - PADDING_Y * 2);

    let startMs = Date.parse(points[0]!.t);
    let endMs = Date.parse(points.at(-1)!.t);
    if (series.dayStart !== undefined && series.dayEnd !== undefined) {
      startMs = Date.parse(series.dayStart);
      endMs = Date.parse(series.dayEnd);
    } else if (series.sessionDate !== undefined) {
      const day = tradingDayForDate(series.sessionDate);
      startMs = day.dayStartMs;
      endMs = day.dayEndMs;
    }
    const xSpan = endMs - startMs || 1;
    const xOf = (ms: number): number => ((ms - startMs) / xSpan) * WIDTH;

    const built = buildSegments(points, xOf, yOf);
    const last = points.at(-1)!;
    return {
      segments: built,
      baselineY: baseline === null || !Number.isFinite(baseline) ? null : yOf(baseline),
      endDot: { x: xOf(Date.parse(last.t)), y: yOf(Number(last.c)) },
    };
  }, [series]);

  const stroke = positive ? 'var(--success)' : 'var(--error)';

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={WIDTH} height={HEIGHT} />
        </clipPath>
      </defs>
      {baselineY !== null && (
        <line
          x1={0}
          x2={WIDTH}
          y1={baselineY}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
          strokeDasharray="1.5 2.5"
        />
      )}
      <g clipPath={`url(#${clipId})`} fill="none" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round">
        {segments.map((segment, index) => (
          <path
            key={index}
            d={segment.path}
            stroke={stroke}
            strokeOpacity={segment.extended ? 0.45 : 1}
          />
        ))}
      </g>
      {endDot !== null && (
        <circle cx={endDot.x} cy={endDot.y} r={1.75} fill={stroke} />
      )}
    </svg>
  );
}
