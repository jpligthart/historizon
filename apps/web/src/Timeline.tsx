import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Category, TimelineItem } from "@historizon/shared";
import {
  BAR_H,
  clearMeasureCache,
  formatPeriod,
  layoutTimeline,
  measureLabel,
  tickYears,
  type Bar,
  fmtYear,
} from "./timelineLayout";
import { CATEGORY_COLORS, t, type Locale } from "./i18n";

type Props = {
  items: TimelineItem[];
  categories: readonly Category[];
  start: number;
  end: number;
  now: number;
  locale: Locale;
  selectedId: string | null;
  /** When a search is active: ids that match. Non-matching items are dimmed. */
  matchIds: Set<string> | null;
  labelOf: (item: TimelineItem) => string;
  onSelect: (item: TimelineItem) => void;
  onPanYears: (deltaYears: number) => void;
  onZoomAt: (factor: number, anchorYear: number) => void;
  onPanBack: () => void;
  onPanForward: () => void;
  onNow: () => void;
  /** The server is still discovering items for this range. */
  loadingMore?: boolean;
  /** SPARQL is paused (rate limit / upstream down); discovery waits. */
  wikiPaused?: boolean;
  /** Pause lasted long enough to show a calmer "delayed" hint. */
  discoverDelayed?: boolean;
  /** Zoom presets (years in view), shown next to the navigation buttons. */
  zoomPresets: readonly number[];
  /** Nederland-bril: rank Dutch items this many times higher (1 = off). */
  nlBoost?: number;
  /** Rows per lane before items are left out (the "Rijen" setting). */
  maxRows?: number;
  onZoom: (years: number) => void;
};

const SELECTED_RING = "0 0 0 2px #fff, 0 0 0 4px #0B1220";

const FADE = "20px";

/**
 * Edge treatment for span bars:
 * - ends within view: rounded corner
 * - continues beyond the visible range: square edge that fades out
 * - ongoing (no end date) and reaching "now": square edge, no fade
 */
function edgeStyle(b: Bar, color: string): CSSProperties {
  const r = "7px";
  const squareRight = b.clipEnd || b.ongoing;
  const style: CSSProperties = {
    borderRadius: `${b.clipStart ? 0 : r} ${squareRight ? 0 : r} ${squareRight ? 0 : r} ${b.clipStart ? 0 : r}`,
  };
  if (b.clipStart || b.clipEnd) {
    // Fade via the background (not a CSS mask), so the selection ring and label stay intact.
    const clear = `${color}00`;
    style.background = `linear-gradient(to right, ${b.clipStart ? clear : color} 0, ${color} ${b.clipStart ? FADE : "0px"}, ${color} calc(100% - ${b.clipEnd ? FADE : "0px"}), ${b.clipEnd ? clear : color} 100%)`;
  }
  return style;
}

export function Timeline({
  items,
  categories,
  start,
  end,
  now,
  locale,
  selectedId,
  matchIds,
  labelOf,
  onSelect,
  onPanYears,
  onZoomAt,
  onPanBack,
  onPanForward,
  onNow,
  loadingMore = false,
  wikiPaused = false,
  discoverDelayed = false,
  zoomPresets,
  nlBoost = 1,
  maxRows,
  onZoom,
}: Props) {
  const span = Math.max(end - start, 1e-6);
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(860);
  const [fontEpoch, setFontEpoch] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<Category>>(new Set());
  const toggleLane = (c: Category) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  const lastX = useRef<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Capture phase, so Esc closes only the help and not the detail panel as well.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [helpOpen]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => {
      if (!alive) return;
      clearMeasureCache();
      setFontEpoch((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const { lanes, bars, bodyHeight } = useMemo(
    () =>
      layoutTimeline({
        items,
        categories,
        start,
        end,
        now,
        width,
        labelOf,
        selectedId,
        expanded,
        nlBoost,
        maxRows,
        measure: measureLabel,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, categories, start, end, now, width, labelOf, selectedId, expanded, nlBoost, maxRows, fontEpoch],
  );


  const ticks = useMemo(() => tickYears(start, end), [start, end]);
  const nowFrac = (now - start) / span;
  const showNow = nowFrac >= 0 && nowFrac <= 1;
  // Narrow track: only period edges as labels (gridlines still use full ticks).
  const compactAxis = width < 480;
  const axisLabels = useMemo(() => {
    if (!compactAxis) return ticks.map((y) => ({ y, edge: null as "start" | "end" | null }));
    const labels: Array<{ y: number; edge: "start" | "end" }> = [
      { y: Math.round(start), edge: "start" },
    ];
    // NU badge already marks the present; skip a duplicate year on top of it.
    if (!showNow || nowFrac < 0.92) {
      labels.push({ y: Math.round(end), edge: "end" });
    }
    return labels;
  }, [compactAxis, ticks, start, end, showNow, nowFrac]);
  const bce = t(locale, "bce");

  // Ctrl/Cmd + wheel zooms around the cursor; horizontal wheel (or Shift + wheel) pans.
  useEffect(() => {
    const el = bodyRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const onWheel = (e: WheelEvent) => {
      const rect = track.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(rect.width, 1)));
        onZoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, start + ratio * span);
        return;
      }
      const dx = e.shiftKey
        ? e.deltaY || e.deltaX
        : Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX
          : 0;
      if (dx !== 0) {
        e.preventDefault();
        onPanYears((dx / Math.max(rect.width, 1)) * span);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [start, span, onPanYears, onZoomAt]);

  const rangeText = `${fmtYear(Math.round(start), bce)} – ${
    end >= now ? t(locale, "now").toLowerCase() : fmtYear(Math.round(end), bce)
  }`;
  const spanText = `${Math.round(span)} ${t(locale, "inView")}`;

  return (
    <section className="tl-card">
      <div className="tl-head">
        <div className="tl-range">
          <div className="tl-range-main">
            <span className="tl-range-text">{rangeText}</span>
            <span className="tl-span-text">{spanText}</span>
          </div>
        </div>
        <div className="tl-nav">
          <div role="group" aria-label={t(locale, "zoom")} title={t(locale, "zoom")} className="segmented zoom">
            {zoomPresets.map((z) => {
              const on = Math.abs(z - span) < 0.5;
              return (
                <button
                  key={z}
                  type="button"
                  className={`seg num${on ? " on" : ""}`}
                  aria-pressed={on}
                  aria-label={`${z} ${t(locale, "years")}`}
                  onClick={() => onZoom(z)}
                >
                  {z}
                </button>
              );
            })}
          </div>
          <span className="tl-nav-sep" aria-hidden="true" />
          <button type="button" className="seg icon-btn" aria-label={t(locale, "earlier")} onClick={onPanBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button type="button" className="seg now-btn" onClick={onNow}>
            {t(locale, "now")}
          </button>
          <button type="button" className="seg icon-btn" aria-label={t(locale, "later")} onClick={onPanForward}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="seg icon-btn help-btn"
            aria-label={t(locale, "helpTitle")}
            title={t(locale, "helpTitle")}
            aria-haspopup="dialog"
            onClick={() => setHelpOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
              <path d="M12 17h.01" />
            </svg>
          </button>
        </div>
      </div>

      {helpOpen && (
        <div className="about-backdrop" onPointerDown={() => setHelpOpen(false)}>
          <div
            className="about-modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="about-head">
              <h2 id="help-title" className="help-title">
                {t(locale, "helpTitle")}
              </h2>
              <button
                type="button"
                className="about-close"
                aria-label={t(locale, "closeDetail")}
                onClick={() => setHelpOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <dl className="help-list">
              <dt>
                <kbd>Ctrl</kbd> + {t(locale, "helpScroll")}
              </dt>
              <dd>{t(locale, "helpZoom")}</dd>
              <dt>
                <kbd>Shift</kbd> + {t(locale, "helpScroll")}
              </dt>
              <dd>{t(locale, "helpPan")}</dd>
              <dt>{t(locale, "helpDrag")}</dt>
              <dd>{t(locale, "helpPan")}</dd>
              <dt>
                <kbd>Ctrl</kbd> + {t(locale, "helpClickChip")}
              </dt>
              <dd>{t(locale, "helpSolo")}</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>{t(locale, "helpEsc")}</dd>
            </dl>
            <p className="help-note">{t(locale, "helpMac")}</p>
          </div>
        </div>
      )}

      {loadingMore && (
        <div className={`tl-status${wikiPaused ? " paused" : ""}`} role="status">
          {!wikiPaused && <span className="spinner" aria-hidden="true" />}
          {t(locale, discoverDelayed ? "discoverDelayed" : "loadingMore")}
        </div>
      )}

      <div className="tl-axis" aria-hidden="true">
        <div className="tl-track" ref={trackRef}>
          {axisLabels.map(({ y, edge }) => (
            <div
              key={`${edge ?? "t"}-${y}`}
              className={`tl-tick${edge ? ` ${edge}` : ""}`}
              style={{
                left:
                  edge === "start"
                    ? "0%"
                    : edge === "end"
                      ? "100%"
                      : `${((y - start) / span) * 100}%`,
              }}
            >
              {fmtYear(y, bce)}
            </div>
          ))}
          {showNow && (
            <div className="tl-now-badge" style={{ left: `${nowFrac * 100}%` }}>
              {t(locale, "now")}
            </div>
          )}
        </div>
      </div>

      <div className="tl-scroll">
      <div
        ref={bodyRef}
        className={`tl-body${dragging ? " dragging" : ""}`}
        style={{ height: bodyHeight }}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          lastX.current = e.clientX;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (lastX.current === null) return;
          const dx = e.clientX - lastX.current;
          lastX.current = e.clientX;
          onPanYears((-dx / Math.max(width, 1)) * span);
        }}
        onPointerUp={() => {
          lastX.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          lastX.current = null;
          setDragging(false);
        }}
      >
        {lanes.map((ln) => (
          <div
            key={ln.category}
            className="tl-lane"
            style={{ top: ln.top, height: ln.height, borderTop: ln.top === 0 ? "none" : undefined }}
          >
            <div className="tl-lane-label">
              <span className="dot" style={{ background: CATEGORY_COLORS[ln.category] }} />
              <span>{t(locale, ln.category)}</span>
            </div>
            {ln.hiddenCount > 0 ? (
              <button
                type="button"
                className="tl-hidden"
                aria-expanded={false}
                title={`${t(locale, "showAll")} ${ln.totalCount} ${t(locale, ln.category).toLowerCase()}`}
                aria-label={`${t(locale, "showAll")} ${ln.totalCount} ${t(locale, ln.category).toLowerCase()}`}
                onClick={() => toggleLane(ln.category)}
              >
                +{ln.hiddenCount}
              </button>
            ) : ln.canCollapse ? (
              <button
                type="button"
                className="tl-hidden"
                aria-expanded={true}
                onClick={() => toggleLane(ln.category)}
              >
                {t(locale, "showLess")}
              </button>
            ) : null}
          </div>
        ))}

        <div className="tl-layer tl-grid" aria-hidden="true">
          {ticks.map((y) => (
            <div key={y} className="tl-gridline" style={{ left: `${((y - start) / span) * 100}%` }} />
          ))}
          {showNow && <div className="tl-now-line" style={{ left: `${nowFrac * 100}%` }} />}
        </div>

        <div className="tl-layer">
          {bars.map((b) => {
            const color = CATEGORY_COLORS[b.category];
            const selected = selectedId === b.item.id;
            const opacity = matchIds && !matchIds.has(b.item.id) ? 0.22 : 1;
            const pick = () => onSelect(b.item);
            const aria = `${b.label}, ${formatPeriod(b.item, t(locale, "present"), bce)}`;
            return (
              <div key={b.item.id}>
                {b.point ? (
                  <button
                    type="button"
                    className="bar bar-point"
                    aria-label={aria}
                    aria-pressed={selected}
                    onClick={pick}
                    style={{ top: b.top, height: BAR_H, left: `calc(${(b.f0 * 100).toFixed(3)}% - 13px)`, opacity }}
                  >
                    <span
                      className="bar-dot"
                      style={{ background: color, boxShadow: selected ? SELECTED_RING : "none" }}
                    />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="bar bar-span"
                    aria-label={aria}
                    aria-pressed={selected}
                    onClick={pick}
                    style={{
                      top: b.top,
                      height: BAR_H,
                      left: `${(b.f0 * 100).toFixed(3)}%`,
                      width: `${((b.f1 - b.f0) * 100).toFixed(3)}%`,
                      background: color,
                      padding: b.inside ? `0 ${b.clipEnd ? 20 : 10}px 0 ${b.clipStart ? 20 : 10}px` : 0,
                      opacity,
                      boxShadow: selected ? SELECTED_RING : "none",
                      ...edgeStyle(b, color),
                    }}
                  >
                    {b.inside && <span className="bar-label">{b.label}</span>}
                  </button>
                )}
                {b.outside && (
                  <button
                    type="button"
                    className="out-label"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={pick}
                    style={{
                      ...b.outside,
                      top: b.top,
                      height: BAR_H,
                      lineHeight: `${BAR_H}px`,
                      opacity,
                      fontWeight: selected ? 600 : 500,
                    }}
                  >
                    {b.label}
                  </button>
                )}
              </div>
            );
          })}
          {bars.length === 0 && <div className="tl-empty">{t(locale, "noResults")}</div>}
        </div>
      </div>
      </div>
    </section>
  );
}
