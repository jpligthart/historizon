import type { CSSProperties } from "react";
import type { Category, TimelineItem } from "@historizon/shared";

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
  /** The item starts before / ends after the visible range (bar is cut off at the edge). */
  clipStart: boolean;
  clipEnd: boolean;
  /** No end date: still going on today. */
  ongoing: boolean;
};

export type Lane = {
  category: Category;
  top: number;
  height: number;
  /** Items in range left out because the lane is capped at MAX_ROWS. */
  hiddenCount: number;
  /** Items in range for this category (drawn + hidden). */
  totalCount: number;
  /** Lane is expanded and actually needs more than MAX_ROWS (so it can be collapsed). */
  canCollapse: boolean;
};

/** Rows per lane; the least notable items that do not fit are left out (level of detail). */
export const MAX_ROWS = 6;
/** Curated items without a sitelink count rank like this (matches the API). */
const DEFAULT_IMPORTANCE = 120;

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export function isPoint(item: TimelineItem): boolean {
  return item.endYear !== null && item.endYear === item.startYear;
}

export function isOngoing(item: TimelineItem): boolean {
  return item.endYear === null;
}

/**
 * Lay items out in one lane per category. Inside a lane, items are packed into at most
 * MAX_ROWS rows so that bars and their (inside or outside) labels never overlap. Items are
 * placed most-notable-first (the selection always goes first), so what gets dropped when a
 * lane is full is the least notable.
 */
export function layoutTimeline(opts: {
  items: TimelineItem[];
  categories: readonly Category[];
  start: number;
  end: number;
  now: number;
  width: number;
  selectedId?: string | null;
  /** Categories shown in full instead of capped at MAX_ROWS. */
  expanded?: ReadonlySet<Category>;
  labelOf: (item: TimelineItem) => string;
  measure: (text: string) => number;
}): { lanes: Lane[]; bars: Bar[]; bodyHeight: number } {
  const { items, categories, start, end, now, labelOf, measure, selectedId, expanded } = opts;
  const span = Math.max(end - start, 1e-6);
  const W = Math.max(opts.width, 1);
  const lanes: Lane[] = [];
  const bars: Bar[] = [];
  const rank = (i: TimelineItem) => (i.id === selectedId ? Infinity : (i.importance ?? DEFAULT_IMPORTANCE));
  let y = 0;

  for (const category of categories) {
    const inLane = items
      .filter((i) => i.category === category)
      .map((i) => ({ item: i, s: i.startYear, e: i.endYear ?? now }))
      .sort((a, b) => rank(b.item) - rank(a.item) || a.s - b.s);

    /** Occupied [start, end] pixel intervals per row. */
    const rows: Array<Array<[number, number]>> = [];
    const laneTop = y;
    let hiddenCount = 0;
    const maxRows = expanded?.has(category) ? Infinity : MAX_ROWS;

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
      const clipStart = !point && s < start;
      const clipEnd = !point && e > end;
      // Clipped edges fade out, so keep the label clear of them.
      const padX = (clipStart ? 20 : 10) + (clipEnd ? 20 : 10);
      const inside = !point && bw >= lw + padX;

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

      const fits = (row: Array<[number, number]>) => row.every(([a, b]) => occE + 8 <= a || occS >= b + 8);
      let row = rows.findIndex(fits);
      if (row === -1) {
        if (rows.length >= maxRows) {
          hiddenCount++;
          continue;
        }
        row = rows.length;
        rows.push([]);
      }
      rows[row].push([occS, occE]);
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

      bars.push({
        item, category, label, top, f0, f1, point, inside, outside,
        clipStart, clipEnd, ongoing: isOngoing(item),
      });
    }

    const height = rows.length === 0 ? EMPTY_LANE_H : 24 + (rows.length - 1) * PITCH + BAR_H;
    lanes.push({
      category,
      top: laneTop,
      height,
      hiddenCount,
      totalCount: inLane.length,
      canCollapse: maxRows === Infinity && rows.length > MAX_ROWS,
    });
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
