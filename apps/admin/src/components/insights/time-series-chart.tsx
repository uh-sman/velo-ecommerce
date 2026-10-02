"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { formatPeriod, niceTicks, type Interval } from "./format";
import { SERIES } from "./series";

/*
 * A dependency-free, single-series time chart: an area (2px line over a 10%
 * wash) or columns (≤24px, 4px rounded tops, square at the baseline). One axis,
 * hairline grid, the series in --brand-600 (validated ≥3:1 against the raised
 * surface in both themes), text in text tokens only.
 *
 * Every bucket is drawn, zeros included — a zero day sits on the baseline, it
 * is never a gap. Hover or arrow keys show a crosshair and readout; two charts
 * can share the active bucket so they read as one figure.
 */

const MARGIN = { top: 12, right: 12, bottom: 28 };
const TICK_FONT = 11;

export interface SeriesPoint {
  period: string;
  value: number;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

/** A column with a 4px rounded data-end and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, base: number): string {
  const height = base - y;
  if (height <= 0) return "";
  const r = Math.min(4, width / 2, height);
  return [
    `M${String(x)},${String(base)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + width - r)}`,
    `Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)}`,
    `V${String(base)}Z`,
  ].join(" ");
}

export function TimeSeriesChart({
  label,
  points,
  kind,
  interval,
  formatValue,
  formatTick,
  height = 200,
  active,
  onActiveChange,
}: {
  label: string;
  points: SeriesPoint[];
  kind: "area" | "bars";
  interval: Interval;
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
  height?: number;
  active: number | null;
  onActiveChange: (index: number | null) => void;
}) {
  const [ref, width] = useWidth();
  const n = points.length;

  const ticks = niceTicks(Math.max(0, ...points.map((point) => point.value)));
  const topTick = ticks[ticks.length - 1] ?? 1;
  const left = Math.max(...ticks.map((tick) => formatTick(tick).length)) * 6.5 + 12;
  const plotWidth = Math.max(0, width - left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const base = MARGIN.top + plotHeight;
  const band = n > 0 ? plotWidth / n : 0;
  const cx = (index: number) => left + band * (index + 0.5);
  const cy = (value: number) => MARGIN.top + plotHeight * (1 - value / topTick);

  const maxLabels = Math.max(2, Math.floor(plotWidth / 72));
  const stride = Math.max(1, Math.ceil(n / maxLabels));

  function pick(event: PointerEvent<SVGRectElement>) {
    if (n === 0 || band === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left) / band);
    onActiveChange(Math.min(n - 1, Math.max(0, index)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (n === 0) return;
    const current = active ?? -1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(n - 1, current + 1);
    else if (event.key === "ArrowLeft") next = current < 0 ? n - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = n - 1;
    else if (event.key === "Escape") {
      onActiveChange(null);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      onActiveChange(next);
    }
  }

  const activePoint = active !== null ? points[active] : undefined;
  const readout = activePoint
    ? `${formatPeriod(activePoint.period, interval, true)}: ${formatValue(activePoint.value)}`
    : "";

  const line = points
    .map(
      (point, index) => `${index === 0 ? "M" : "L"}${String(cx(index))},${String(cy(point.value))}`,
    )
    .join(" ");
  const area =
    n > 1
      ? `${line} L${String(cx(n - 1))},${String(base)} L${String(cx(0))},${String(base)} Z`
      : "";
  const barWidth = Math.max(1, Math.min(24, band * 0.62));
  const last = points[n - 1];

  return (
    <div
      ref={ref}
      className="relative w-full rounded-md outline-offset-4"
      style={{ height }}
      tabIndex={0}
      // Arrow keys step through the buckets, so it is announced as a slider
      // whose value text is the bucket's readout.
      role="slider"
      aria-label={`${label}. Use the arrow keys to read each ${interval}.`}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, n - 1)}
      aria-valuenow={active ?? 0}
      aria-valuetext={readout || "Use the arrow keys to read values"}
      onKeyDown={onKeyDown}
      onBlur={() => {
        onActiveChange(null);
      }}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden className="block overflow-visible">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - MARGIN.right}
                y1={cy(tick)}
                y2={cy(tick)}
                shapeRendering="crispEdges"
                style={{ stroke: tick === 0 ? "var(--border-default)" : "var(--border-subtle)" }}
              />
              <text
                x={left - 8}
                y={cy(tick)}
                dy="0.32em"
                textAnchor="end"
                fontSize={TICK_FONT}
                style={{ fill: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}
              >
                {formatTick(tick)}
              </text>
            </g>
          ))}

          {points.map((point, index) =>
            index % stride === 0 ? (
              <text
                key={point.period}
                x={Math.min(width - MARGIN.right - 18, Math.max(left + 18, cx(index)))}
                y={base + 18}
                textAnchor="middle"
                fontSize={TICK_FONT}
                style={{ fill: "var(--text-tertiary)" }}
              >
                {formatPeriod(point.period, interval)}
              </text>
            ) : null,
          )}

          {kind === "bars" &&
            points.map((point, index) => (
              <path
                key={point.period}
                d={columnPath(cx(index) - barWidth / 2, cy(point.value), barWidth, base)}
                style={{
                  fill: SERIES,
                  opacity: active === null || active === index ? 1 : 0.45,
                }}
              />
            ))}

          {kind === "area" && n > 0 && (
            <>
              {area && <path d={area} style={{ fill: SERIES, opacity: 0.1 }} />}
              <path
                d={line}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ stroke: SERIES }}
              />
              {last && active === null && (
                <circle
                  cx={cx(n - 1)}
                  cy={cy(last.value)}
                  r={4}
                  strokeWidth={2}
                  style={{ fill: SERIES, stroke: "var(--surface-raised)" }}
                />
              )}
            </>
          )}

          {activePoint && active !== null && (
            <>
              <line
                x1={cx(active)}
                x2={cx(active)}
                y1={MARGIN.top}
                y2={base}
                shapeRendering="crispEdges"
                style={{ stroke: "var(--border-strong)" }}
              />
              {kind === "area" && (
                <circle
                  cx={cx(active)}
                  cy={cy(activePoint.value)}
                  r={4}
                  strokeWidth={2}
                  style={{ fill: SERIES, stroke: "var(--surface-raised)" }}
                />
              )}
            </>
          )}

          <rect
            x={left}
            y={MARGIN.top}
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={() => {
              onActiveChange(null);
            }}
          />
        </svg>
      )}

      {activePoint && active !== null && width > 0 && (
        <div
          aria-hidden
          className="border-border-subtle bg-surface-overlay pointer-events-none absolute top-0 z-10 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(width - 150, Math.max(0, cx(active) + 10)),
            minWidth: 120,
          }}
        >
          <div className="text-text-secondary">
            {formatPeriod(activePoint.period, interval, true)}
          </div>
          <div className="text-text-primary font-semibold">{formatValue(activePoint.value)}</div>
        </div>
      )}
    </div>
  );
}
