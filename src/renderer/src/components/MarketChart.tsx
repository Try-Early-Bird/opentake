import { User, Users } from 'lucide-react';
import { money } from '../portfolio/format';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartWatermark } from './ChartWatermark';
import { tradingDayForDate, type SymbolSeries } from '../market-series';
import type { PortfolioRange } from '../portfolio-history';

// Robinhood-style instrument chart: no axes, a dotted baseline (previous
// close for 1D, window open otherwise). The regular session draws in the
// change color; pre-market, after-hours, and overnight segments are the same
// color muted, not a second color. For 1D the x-axis spans the full Eastern
// calendar day, so the line is drawn only as far as now and fills in as the
// day progresses.

export interface MarketHoverPoint {
  timestamp: number;
  value: number;
  /** Overlay values at the same point, by overlay key; null where an overlay has no value yet. */
  overlays?: Record<string, number | null>;
  /** Markers that sit on this point, when the chart has any. */
  markers?: ChartMarker[];
}

/**
 * Money in or out at a moment: a dot on the line where it happened with a
 * badge right beside it -- green for money in, red for money out, a person
 * or a group inside, a ring for the author or the viewer -- and a faint
 * vertical guide. Several on one point in one direction share a badge.
 */
export interface ChartMarker {
  at: string;
  direction: 'in' | 'out';
  party: 'owner' | 'viewer' | 'others';
  members: number;
  amount: string | null;
  currency?: string;
  kinds: Partial<Record<'invested' | 'deposit' | 'withdrew' | 'closed', number>>;
  /** Per action: how many people and what it moved. Absent from older API responses. */
  breakdown?: Array<{ kind: 'invested' | 'deposit' | 'withdrew' | 'closed'; members: number; amount: string | null }>;
  /** Opaque per-strategy keys of the people in the group, so merged groups count each person once. */
  memberKeys?: string[];
}

/**
 * How many different people are in a set of markers. Each group carries its
 * people's opaque keys, so someone in several merged groups counts once;
 * a response without keys falls back to the groups' own counts.
 */
export function distinctPeople(markers: readonly ChartMarker[]): number {
  if (markers.every((marker) => marker.memberKeys !== undefined)) {
    return new Set(markers.flatMap((marker) => marker.memberKeys ?? [])).size;
  }
  return markers.reduce((total, marker) => total + marker.members, 0);
}

/** A marker in words: the headline, and for a group a breakdown by action. */
export interface MarkerCopy {
  text: string;
  detail: string | null;
}

/** Direction decides the color: money in is the theme's gain color, money out its loss color. */
export const MARKER_COLORS: Record<ChartMarker['direction'], string> = {
  in: 'var(--success)',
  out: 'var(--error)',
};

/** Who is marked by a ring: the author in the theme's chart color, the viewer in the foreground; others have none. */
const PARTY_RING: Record<ChartMarker['party'], string | null> = {
  owner: 'var(--chart-1)',
  viewer: 'var(--foreground)',
  others: null,
};

const PARTY_RANK: Record<ChartMarker['party'], number> = { owner: 0, viewer: 1, others: 2 };

interface MarkerGlyph {
  timestamp: number;
  /** For a cluster of nearby markers, the last one's time; otherwise the same as `timestamp`. */
  lastTimestamp?: number;
  value: number;
  direction: ChartMarker['direction'];
  /** The most prominent party on the point decides the color. */
  party: ChartMarker['party'];
  markers: ChartMarker[];
}

/**
 * The badge beside a marker's point on the line: a disc in the direction's color
 * holding a person, or a group with a count when several people moved money
 * that day; a ring marks the author or the viewer.
 */
function MarkerBadge({ cx: x, cy: pointY, glyph, onHover }: {
  cx?: number;
  cy?: number;
  glyph: MarkerGlyph;
  onHover: (hover: { glyph: MarkerGlyph; x: number; y: number } | null) => void;
}): React.JSX.Element | null {
  if (x === undefined || pointY === undefined || !Number.isFinite(x) || !Number.isFinite(pointY)) return null;
  // Right above the point where the money met the line, so the badge reads
  // against the price; below it when the point is too near the top.
  const cy = pointY - 18 < 12 ? pointY + 18 : pointY - 18;
  const people = distinctPeople(glyph.markers);
  const ring = PARTY_RING[glyph.party];
  const Icon = people > 1 ? Users : User;
  return (
    <g
      style={{ cursor: 'default' }}
      onMouseEnter={() => onHover({ glyph, x, y: cy })}
      onMouseLeave={() => onHover(null)}
    >
      {/* A wider transparent target than the disc, so the tooltip is easy to reach. */}
      <circle cx={x} cy={cy} r={13} fill="transparent" />
      {ring !== null && <circle cx={x} cy={cy} r={10.5} fill="none" stroke={ring} strokeWidth={1.5} />}
      <circle cx={x} cy={cy} r={8} fill={MARKER_COLORS[glyph.direction]} />
      <Icon x={x - 5} y={cy - 5} width={10} height={10} color="var(--background)" strokeWidth={2.5} />
      {people > 1 && (
        <text x={x + 9} y={cy - 6} fontSize={9} fontWeight={600} fill="var(--foreground)">{people}</text>
      )}
    </g>
  );
}

function defaultMarkerDescription(marker: ChartMarker): MarkerCopy {
  const amount = marker.amount === null ? '' : ` ${money(marker.amount)}`;
  return { text: `${marker.members} ${marker.members === 1 ? 'person' : 'people'} ${marker.direction === 'in' ? 'put in' : 'took out'}${amount}`, detail: null };
}

/** Badges closer than this on screen merge into one, so a busy stretch reads as one badge rather than a pile. */
const CLUSTER_PX = 24;
/** A tooltip lists at most this many lines, then how many more. */
const TOOLTIP_LINES = 5;

/** A second line drawn beside the main series, e.g. a benchmark rebased to the same start. */
export interface ChartOverlay {
  key: string;
  color: string;
  /** Points on the main series' timestamps; missing timestamps draw as gaps. */
  points: readonly { timestamp: number; value: number }[];
}

interface ChartPoint {
  timestamp: number;
  value: number;
  regular: number | null;
  extended: number | null;
  [overlay: `overlay:${string}`]: number | null;
}

// Extended-hours segments use the main line color at this opacity.
export const EXTENDED_HOURS_OPACITY = 0.4;

function hoverTimeLabel(timestamp: number, range: PortfolioRange): string {
  const date = new Date(timestamp);
  if (range === '1d') return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (range === '1w' || range === '1m') {
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function MarketChart({
  series,
  range,
  positive,
  onHoverPoint,
  overlays = [],
  markers = [],
  describeMarker = defaultMarkerDescription,
}: {
  series: SymbolSeries;
  range: PortfolioRange;
  positive: boolean;
  onHoverPoint?: (point: MarketHoverPoint | null) => void;
  overlays?: readonly ChartOverlay[];
  markers?: readonly ChartMarker[];
  /** One line per marker for the tooltip, e.g. "The author invested $60.00". */
  describeMarker?: (marker: ChartMarker) => MarkerCopy;
}): React.JSX.Element {
  const [hoveredMarker, setHoveredMarker] = useState<{ glyph: MarkerGlyph; x: number; y: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const { data, domain, baseline, yDomain } = useMemo(() => {
    const raw = series.points
      .map((point) => ({ timestamp: Date.parse(point.t), value: Number(point.c), session: point.s }))
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
    // Split into regular and extended series; boundary points carry both so
    // the line stays continuous where the session changes.
    const points: ChartPoint[] = raw.map((point, index) => {
      const isRegular = point.session === 'regular';
      const neighborRegular = raw[index - 1]?.session === 'regular' || raw[index + 1]?.session === 'regular';
      const neighborExtended = (raw[index - 1] !== undefined && raw[index - 1]!.session !== 'regular') ||
        (raw[index + 1] !== undefined && raw[index + 1]!.session !== 'regular');
      return {
        timestamp: point.timestamp,
        value: point.value,
        regular: isRegular || neighborRegular ? point.value : null,
        extended: !isRegular || neighborExtended ? point.value : null,
      };
    });
    const baselineValue = series.baseline === null ? null : Number(series.baseline.price);
    let start = points[0]?.timestamp ?? 0;
    let end = points.at(-1)?.timestamp ?? start;
    if (series.dayStart !== undefined && series.dayEnd !== undefined) {
      start = Date.parse(series.dayStart);
      end = Date.parse(series.dayEnd);
    } else if (series.sessionDate !== undefined) {
      const day = tradingDayForDate(series.sessionDate);
      start = day.dayStartMs;
      end = day.dayEndMs;
    }
    // Overlays join by timestamp; their values widen the y-range so no line clips.
    for (const overlay of overlays) {
      const byTimestamp = new Map(overlay.points.map((point) => [point.timestamp, point.value]));
      for (const point of points) point[`overlay:${overlay.key}`] = byTimestamp.get(point.timestamp) ?? null;
    }
    const values = points.map((point) => point.value);
    for (const overlay of overlays) for (const point of overlay.points) values.push(point.value);
    if (baselineValue !== null && Number.isFinite(baselineValue)) values.push(baselineValue);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const pad = (maximum - minimum || Math.abs(maximum) * 0.01 || 1) * 0.08;
    return {
      data: points,
      domain: [start, end === start ? start + 1 : end] as [number, number],
      baseline: baselineValue !== null && Number.isFinite(baselineValue) ? baselineValue : null,
      yDomain: [minimum - pad, maximum + pad] as [number, number],
    };
  }, [series, overlays]);

  // Each marker sits on the nearest point: daily points are stamped at the
  // end of the trading day, so "the last point before" put a mid-session
  // event on the previous day (2026-09-29). One outside the drawn line is not shown.
  const glyphs = useMemo(() => {
    const byPoint = new Map<string, MarkerGlyph>();
    if (data.length === 0) return [] as MarkerGlyph[];
    for (const marker of markers) {
      const at = Date.parse(marker.at);
      if (!Number.isFinite(at) || at < domain[0] || at > domain[1]) continue;
      let index = 0;
      for (let candidate = 1; candidate < data.length; candidate += 1) {
        if (Math.abs(data[candidate]!.timestamp - at) < Math.abs(data[index]!.timestamp - at)) index = candidate;
      }
      const point = data[index]!;
      const key = `${index}:${marker.direction}`;
      const glyph = byPoint.get(key);
      if (glyph === undefined) {
        byPoint.set(key, { timestamp: point.timestamp, value: point.value, direction: marker.direction, party: marker.party, markers: [marker] });
      } else {
        glyph.markers.push(marker);
        if (PARTY_RANK[marker.party] < PARTY_RANK[glyph.party]) glyph.party = marker.party;
      }
    }
    return [...byPoint.values()];
  }, [data, domain, markers]);
  // Badges that would overlap on screen merge: a busy week on a 1Y chart, or
  // money in and out on the same day, reads as one badge with everyone in it,
  // colored by the net flow. Each keeps its own dot and guide on the line.
  const [plotWidth, setPlotWidth] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setPlotWidth(Math.max(0, element.clientWidth - 32)));
    observer.observe(element);
    setPlotWidth(Math.max(0, element.clientWidth - 32));
    return () => observer.disconnect();
  }, []);
  const clusters = useMemo(() => {
    const span = domain[1] - domain[0];
    const px = (timestamp: number) => (span <= 0 || plotWidth === 0 ? 0 : ((timestamp - domain[0]) / span) * plotWidth);
    const sorted = [...glyphs].sort((left, right) => left.timestamp - right.timestamp);
    const merged: MarkerGlyph[] = [];
    let lastPx = -Infinity;
    for (const glyph of sorted) {
      const at = px(glyph.timestamp);
      const current = merged.at(-1);
      if (current !== undefined && plotWidth > 0 && at - lastPx < CLUSTER_PX) {
        current.markers = [...current.markers, ...glyph.markers];
        current.lastTimestamp = glyph.timestamp;
        if (PARTY_RANK[glyph.party] < PARTY_RANK[current.party]) current.party = glyph.party;
      } else {
        merged.push({ ...glyph, markers: [...glyph.markers] });
      }
      lastPx = at;
    }
    for (const cluster of merged) {
      const net = cluster.markers.reduce((total, marker) =>
        total + (marker.amount === null ? 0 : Number(marker.amount) * (marker.direction === 'in' ? 1 : -1)), 0);
      if (net !== 0) cluster.direction = net > 0 ? 'in' : 'out';
    }
    return merged;
  }, [glyphs, domain, plotWidth]);
  const markersAt = useMemo(() => {
    const map = new Map<number, ChartMarker[]>();
    for (const glyph of glyphs) map.set(glyph.timestamp, [...(map.get(glyph.timestamp) ?? []), ...glyph.markers]);
    return map;
  }, [glyphs]);

  const stroke = positive ? 'var(--success)' : 'var(--error)';
  // With markers drawn, the price line steps back a little so their gain and
  // loss colors are not lost in a line of the same color.
  const lineOpacity = glyphs.length > 0 ? 0.6 : 1;

  return (
    <div ref={container} className="relative h-full min-h-0 w-full" role="img" aria-label={`${series.symbol} price chart`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          // A badge is wider than the line; room for the first and last ones.
          margin={{ top: 24, right: glyphs.length > 0 ? 16 : 8, left: glyphs.length > 0 ? 16 : 8, bottom: 8 }}
          onMouseMove={(state) => {
            const index = Number(state.activeTooltipIndex);
            const point = state.isTooltipActive && Number.isInteger(index) ? data[index] : undefined;
            onHoverPoint?.(point === undefined
              ? null
              : {
                  timestamp: point.timestamp,
                  value: point.value,
                  overlays: Object.fromEntries(overlays.map((overlay) => [overlay.key, point[`overlay:${overlay.key}`] ?? null])),
                  ...(markersAt.has(point.timestamp) ? { markers: markersAt.get(point.timestamp)! } : {}),
                });
          }}
          onMouseLeave={() => onHoverPoint?.(null)}
        >
          <XAxis dataKey="timestamp" type="number" domain={domain} hide />
          <YAxis domain={yDomain} hide />
          {baseline !== null && (
            <ReferenceLine y={baseline} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 4" />
          )}
          <Tooltip
            position={{ y: 0 }}
            offset={0}
            isAnimationActive={false}
            cursor={{ stroke: '#666', strokeWidth: 1 }}
            content={({ active, label }) => {
              if (active !== true || label === undefined) return null;
              return (
                <div
                  className="whitespace-nowrap text-[11px] font-medium text-muted-foreground"
                  style={{ transform: 'translateX(-50%)' }}
                >
                  {hoverTimeLabel(Number(label), range)}
                </div>
              );
            }}
          />
          {overlays.map((overlay) => (
            <Line
              key={overlay.key}
              type="linear"
              dataKey={`overlay:${overlay.key}`}
              stroke={overlay.color}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: overlay.color, stroke: '#fff', strokeWidth: 1.5 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          <Line
            type="linear"
            dataKey="extended"
            stroke={stroke}
            strokeOpacity={EXTENDED_HOURS_OPACITY * lineOpacity}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: stroke, fillOpacity: EXTENDED_HOURS_OPACITY, stroke: '#fff', strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="regular"
            stroke={stroke}
            strokeOpacity={lineOpacity}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: stroke, stroke: '#fff', strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          {glyphs.map((glyph) => (
            <ReferenceLine
              key={`${glyph.timestamp}:${glyph.direction}`}
              x={glyph.timestamp}
              stroke={MARKER_COLORS[glyph.direction]}
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
          ))}
          {/* Where the money met the line -- the strategy's level at that
              moment -- with its badge right beside it. */}
          {glyphs.map((glyph) => (
            <ReferenceDot
              key={`dot:${glyph.timestamp}:${glyph.direction}`}
              x={glyph.timestamp}
              y={glyph.value}
              r={3.5}
              fill={MARKER_COLORS[glyph.direction]}
              stroke="var(--background)"
              strokeWidth={1.5}
            />
          ))}
          {clusters.map((cluster) => (
            <ReferenceDot
              key={`badge:${cluster.timestamp}:${cluster.direction}`}
              x={cluster.timestamp}
              y={cluster.value}
              r={0}
              shape={(props: { cx?: number; cy?: number }) => (
                <MarkerBadge cx={props.cx} cy={props.cy} glyph={cluster} onHover={setHoveredMarker} />
              )}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {hoveredMarker !== null && (() => {
        const last = data.at(-1)?.value;
        const since = last === undefined || hoveredMarker.glyph.value === 0
          ? null
          : ((last - hoveredMarker.glyph.value) / hoveredMarker.glyph.value) * 100;
        return (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 w-max max-w-[min(20rem,100%)] rounded-xl bg-neutral-950 px-3 py-2.5 text-xs text-white shadow-lg ring-1 ring-white/10"
            style={(() => {
              // Beside the badge and inside the chart: below it in the top half,
              // above it in the bottom half, and held in from either edge.
              const width = container.current?.clientWidth ?? Infinity;
              const height = container.current?.clientHeight ?? Infinity;
              const vertical = hoveredMarker.y > height / 2
                ? { bottom: Math.max(0, height - hoveredMarker.y + 16) }
                : { top: hoveredMarker.y + 16 };
              if (hoveredMarker.x < 130) return { left: Math.max(0, hoveredMarker.x - 16), ...vertical };
              if (hoveredMarker.x > width - 130) return { right: Math.max(0, width - hoveredMarker.x - 16), ...vertical };
              return { left: hoveredMarker.x, ...vertical, transform: 'translateX(-50%)' };
            })()}
          >
            {[...hoveredMarker.glyph.markers]
              .sort((left, right) => left.at.localeCompare(right.at))
              .slice(0, TOOLTIP_LINES)
              .map((marker) => {
                const copy = describeMarker(marker);
                return (
                  <div key={`${marker.party}:${marker.direction}:${marker.at}`} className="py-0.5">
                    <div className="flex items-center gap-2">
                      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full text-[11px] text-white" style={{backgroundColor:MARKER_COLORS[marker.direction]}} aria-hidden>{marker.direction==='in'?'↑':'↓'}</span>
                      <span className="font-medium">{copy.text.replace(/^You ([a-z])/,(_,letter:string)=>letter.toUpperCase())}</span>
                      <span className="ml-auto whitespace-nowrap pl-2 text-[10px] text-neutral-400">{new Date(marker.at).toLocaleDateString([], {month:'short',day:'numeric'})} · {new Date(marker.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span>
                    </div>
                    {copy.detail !== null && <p className="mt-1 pl-6 text-neutral-400">{copy.detail}</p>}
                  </div>
                );
              })}
            {hoveredMarker.glyph.markers.length > TOOLTIP_LINES && (
              <p className="mt-1 text-neutral-400">+{hoveredMarker.glyph.markers.length - TOOLTIP_LINES} more</p>
            )}
            {since !== null && (
              <div className="mt-2 flex items-baseline justify-between gap-6 border-t border-white/15 pt-2"><span className="text-[11px] text-neutral-400">
                {hoveredMarker.glyph.lastTimestamp !== undefined && hoveredMarker.glyph.lastTimestamp !== hoveredMarker.glyph.timestamp
                  ? `Since ${new Date(hoveredMarker.glyph.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                  : 'Since then'}</span><span className={`font-mono text-xs tabular-nums ${since>=0?'text-success':'text-error'}`}>{since >= 0 ? '+' : ''}{since.toFixed(2)}%</span>
              </div>
            )}
          </div>
        );
      })()}
      <ChartWatermark className="bottom-3" />
    </div>
  );
}
