import type { CSSProperties } from "react";
import type { Category, TimelineItem } from "@historizon/shared";

export const LABEL_COL = 120;
export const BAR_H = 26;
export const PITCH = 32;
const EMPTY_LANE_H = 56;
const MIN_BODY_H = 160;

export type Bar = {
  item: TimelineItem;
  category: Category;
  label: string;
  top: number;
  f0: number;
  f1: number;
  point: boolean;
  inside: boolean;
  /** Position of the outside label, or null when the label fits inside the bar. */
  outside: CSSProperties | null;
};

export type Lane = {
  category: Category;
  top: number;
  height: number;
};

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export function isPoint(item: TimelineItem): boolean {
  return item.endYear !== null && item.endYear === item.startYear;
}

export function isOngoing(item: TimelineItem): boolean {
  return item.endYear === null;
}

/**
 * Lay items out in one lane per category. Inside a lane, items are packed into rows
 * so that bars and their (inside or outside) labels never overlap.
 */
export function layoutTimeline(opts: {
  items: TimelineItem[];
  categories: readonly Category[];
  start: number;
  end: number;
  now: number;
  width: number;
  labelOf: (item: TimelineItem) => string;
  measure: (text: string) => number;
}): { lanes: Lane[]; bars: Bar[]; bodyHeight: number } {
  const { items, categories, start, end, now, labelOf, measure } = opts;
  const span = Math.max(end - start, 1e-6);
  const W = Math.max(opts.width, 1);
  const lanes: Lane[] = [];
  const bars: Bar[] = [];
  let y = 0;

  for (const category of categories) {
    const inLane = items
      .filter((i) => i.category === category)
      .map((i) => ({ item: i, s: i.startYear, e: i.endYear ?? now }))
      .sort((a, b) => a.s - b.s || b.e - a.e);

    const rowsEnd: number[] = [];
    const laneTop = y;

    for (const { item, s, e } of inLane) {
      const label = labelOf(item);
      const point = isPoint(item);
      const f0 = Math.max(0, (s - start) / span);
      const f1 = Math.min(1, (e - start) / span);
      const x0 = f0 * W;
      const bw = point ? 12 : Math.max(12, (f1 - f0) * W);
      const lw = measure(label) + 4;
      const barStart = point ? x0 - 6 : x0;
      const barEnd = point ? x0 + 6 : x0 + bw;
      const inside = !point && bw >= lw + 20;

      let side: "r" | "l" = "r";
      let occS = barStart;
      let occE = barEnd;
      if (!inside) {
        if (barEnd + 8 + lw <= W || barStart - 8 - lw < 0) {
          occE = barEnd + 8 + lw;
        } else {
          side = "l";
          occS = barStart - 8 - lw;
        }
      }

      let row = 0;
      while (row < rowsEnd.length && rowsEnd[row] + 8 > occS) row++;
      rowsEnd[row] = occE;
      const top = laneTop + 12 + row * PITCH;

      let outside: CSSProperties | null = null;
      if (!inside) {
        if (side === "r") {
          if (point) outside = { left: `calc(${pct(f0)} + 14px)` };
          else if ((f1 - f0) * W < 12) outside = { left: `calc(${pct(f0)} + 20px)` };
          else outside = { left: `calc(${pct(f1)} + 8px)` };
        } else {
          outside = { right: `calc(${pct(1 - f0)} + ${point ? 14 : 8}px)` };
        }
      }

      bars.push({ item, category, label, top, f0, f1, point, inside, outside });
    }

    const rows = rowsEnd.length;
    const height = rows === 0 ? EMPTY_LANE_H : 24 + (rows - 1) * PITCH + BAR_H;
    lanes.push({ category, top: laneTop, height });
    y += height;
  }

  return { lanes, bars, bodyHeight: Math.max(y, MIN_BODY_H) };
}

export function tickStep(span: number): number {
  if (span <= 12) return 1;
  if (span <= 20) return 2;
  if (span <= 50) return 5;
  if (span <= 100) return 10;
  if (span <= 250) return 25;
  if (span <= 500) return 50;
  if (span <= 1000) return 100;
  if (span <= 2500) return 250;
  return 500;
}

export function tickYears(start: number, end: number): number[] {
  const step = tickStep(end - start);
  const ticks: number[] = [];
  for (let y = Math.ceil(start / step) * step; y <= end; y += step) ticks.push(y);
  return ticks;
}

export function fmtYear(year: number, bce: string): string {
  return year < 0 ? `${Math.abs(year)} ${bce}` : String(year);
}

/** "1947 – 1991", "1969" or "2022 – heden". */
export function formatPeriod(item: TimelineItem, presentLabel: string, bce: string): string {
  const a = fmtYear(item.startYear, bce);
  if (isPoint(item)) return a;
  if (isOngoing(item)) return `${a} – ${presentLabel}`;
  return `${a} – ${fmtYear(item.endYear as number, bce)}`;
}

/** Compact variant for lists: "1947–1991", "1969", "2022–". */
export function formatYearsCompact(item: TimelineItem, bce: string): string {
  const a = fmtYear(item.startYear, bce);
  if (isPoint(item)) return a;
  if (isOngoing(item)) return `${a}–`;
  return `${a}–${fmtYear(item.endYear as number, bce)}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const measureCache = new Map<string, number>();

/** Width of a timeline label in px (13px Inter, weight 500). */
export function measureLabel(text: string): number {
  const cached = measureCache.get(text);
  if (cached !== undefined) return cached;
  if (!measureCtx && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  let w = text.length * 7;
  if (measureCtx) {
    measureCtx.font = "500 13px Inter, system-ui, sans-serif";
    w = Math.ceil(measureCtx.measureText(text).width);
  }
  measureCache.set(text, w);
  return w;
}

export function clearMeasureCache(): void {
  measureCache.clear();
}
