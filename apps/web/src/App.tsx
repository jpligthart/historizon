import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  CATEGORIES,
  DEFAULT_ZOOM_YEARS,
  ZOOM_PRESETS_YEARS,
  type Category,
  type TimelineItem,
  type TimelineMeta,
} from "@historizon/shared";
import { fetchItem, fetchItems, fetchMeta } from "./api";
import { Timeline } from "./Timeline";
import { DetailPanel } from "./DetailPanel";
import { CATEGORY_COLORS, t, type Locale } from "./i18n";

/** Current moment as a fractional year, e.g. 2026.87. */
function currentFractionalYear(): number {
  const d = new Date();
  const y = d.getFullYear();
  const startOfYear = new Date(y, 0, 1).getTime();
  const startOfNext = new Date(y + 1, 0, 1).getTime();
  return y + (d.getTime() - startOfYear) / (startOfNext - startOfYear);
}

const NOW = currentFractionalYear();
const NOW_YEAR = Math.floor(NOW);
/** A little breathing room to the right of "now". */
const RIGHT_PAD = 0.03;
const FULL_RANGE = { from: -100000, to: 100000 };
const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<Category, number>;

export function App() {
  const [locale, setLocale] = useState<Locale>("nl");
  const [meta, setMeta] = useState<TimelineMeta | null>(null);
  const [view, setView] = useState({ span: DEFAULT_ZOOM_YEARS, end: NOW + DEFAULT_ZOOM_YEARS * RIGHT_PAD });
  const { span, end } = view;
  const start = end - span;
  const [hidden, setHidden] = useState<Set<Category>>(new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [matches, setMatches] = useState<TimelineItem[]>([]);
  const [selected, setSelected] = useState<TimelineItem | null>(null);
  const [detail, setDetail] = useState<TimelineItem | null>(null);
  const [concurrentAll, setConcurrentAll] = useState<TimelineItem[]>([]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    fetchMeta().then(setMeta).catch((err) => console.error(err));
  }, []);

  const clampEnd = useCallback(
    (s: number, e: number) => {
      const maxEnd = NOW + s * RIGHT_PAD;
      const minEnd = (meta?.minYear ?? -3500) - s * RIGHT_PAD + s;
      return Math.min(maxEnd, Math.max(minEnd, e));
    },
    [meta],
  );

  // Items in the viewport. All categories are fetched so chips can show counts;
  // hidden categories are filtered out client-side.
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      fetchItems({ from: start, to: end, limit: 2000 })
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch((err) => console.error(err));
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [start, end]);

  // Search matches across all of history (for the match count and "jump to first").
  useEffect(() => {
    if (!deferredQuery) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      fetchItems({ ...FULL_RANGE, q: deferredQuery, limit: 2000 })
        .then((next) => {
          if (!cancelled) setMatches(next);
        })
        .catch((err) => console.error(err));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [deferredQuery]);

  // Enriched detail (Wikipedia extract) for the selected item.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetchItem(selected.id)
      .then((item) => {
        if (!cancelled) setDetail(item);
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // Everything that overlaps the selected item in time.
  useEffect(() => {
    if (!selected) {
      setConcurrentAll([]);
      return;
    }
    let cancelled = false;
    fetchItems({ from: selected.startYear, to: selected.endYear ?? NOW_YEAR, limit: 2000 })
      .then((next) => {
        if (!cancelled) setConcurrentAll(next);
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.startYear, selected?.endYear]);

  const labelOf = useCallback(
    (item: TimelineItem) => (locale === "nl" && item.titleNl ? item.titleNl : item.title),
    [locale],
  );

  const visibleCategories = useMemo(() => CATEGORIES.filter((c) => !hidden.has(c)), [hidden]);
  const visibleItems = useMemo(() => items.filter((i) => !hidden.has(i.category)), [items, hidden]);
  const visibleMatches = useMemo(
    () => matches.filter((i) => !hidden.has(i.category)).sort((a, b) => a.startYear - b.startYear),
    [matches, hidden],
  );
  const matchIds = useMemo(
    () => (deferredQuery ? new Set(matches.map((m) => m.id)) : null),
    [matches, deferredQuery],
  );
  const concurrent = useMemo(
    () =>
      selected
        ? concurrentAll
            .filter((i) => i.id !== selected.id && !hidden.has(i.category))
            .sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.startYear - b.startYear)
        : [],
    [concurrentAll, selected, hidden],
  );

  const select = useCallback((item: TimelineItem) => setSelected(item), []);

  const setZoom = (z: number) =>
    setView((v) => {
      const center = v.end - v.span / 2;
      return { span: z, end: clampEnd(z, center + z / 2) };
    });

  const onPanYears = useCallback(
    (delta: number) => setView((v) => ({ ...v, end: clampEnd(v.span, v.end + delta) })),
    [clampEnd],
  );

  const onZoomAt = useCallback(
    (factor: number, anchor: number) =>
      setView((v) => {
        const maxSpan = Math.max(5000, NOW - (meta?.minYear ?? -3500));
        const nextSpan = Math.min(maxSpan, Math.max(5, v.span * factor));
        const vStart = v.end - v.span;
        const ratio = (anchor - vStart) / v.span;
        const nextEnd = anchor + nextSpan * (1 - ratio);
        return { span: nextSpan, end: clampEnd(nextSpan, nextEnd) };
      }),
    [clampEnd, meta],
  );

  const panBy = (dir: 1 | -1) =>
    setView((v) => ({ ...v, end: clampEnd(v.span, v.end + dir * Math.round(v.span / 2)) }));

  const goNow = () => setView((v) => ({ ...v, end: clampEnd(v.span, NOW + v.span * RIGHT_PAD) }));

  const jumpToFirst = () => {
    const m = visibleMatches[0];
    if (!m) return;
    const mid = (m.startYear + (m.endYear ?? NOW)) / 2;
    setView((v) => ({ ...v, end: clampEnd(v.span, mid + v.span / 2) }));
    setSelected(m);
  };

  const toggleCategory = (cat: Category) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  return (
    <div className="app">
      <header className="top">
        <div className="brand-wrap">
          <div className="brand">
            <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
              <rect x="2" y="5" width="16" height="5" rx="2.5" fill="#0F766E" />
              <rect x="8" y="12" width="18" height="5" rx="2.5" fill="#1D4ED8" />
              <rect x="5" y="19" width="12" height="5" rx="2.5" fill="#B91C1C" />
            </svg>
            <h1>{t(locale, "brand")}</h1>
          </div>
          <span className="tagline">{t(locale, "tagline")}</span>
        </div>
        <div className="control-group">
          <span className="control-label">{t(locale, "language")}</span>
          <div role="group" aria-label={t(locale, "language")} className="segmented">
            {(["nl", "en"] as const).map((lg) => (
              <button
                key={lg}
                type="button"
                className={`seg${locale === lg ? " on" : ""}`}
                aria-pressed={locale === lg}
                onClick={() => setLocale(lg)}
              >
                {lg.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="toolbar">
        <div className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") jumpToFirst();
            }}
            placeholder={t(locale, "searchPlaceholder")}
            aria-label={t(locale, "search")}
          />
        </div>

        {deferredQuery && visibleMatches.length > 0 && (
          <div className="matches">
            <span>
              {visibleMatches.length} {t(locale, "matches")}
            </span>
            <button type="button" className="seg outline-btn" onClick={jumpToFirst}>
              {t(locale, "jump")}
            </button>
          </div>
        )}

        <div className="chips" role="group" aria-label={t(locale, "categories")}>
          {CATEGORIES.map((cat) => {
            const on = !hidden.has(cat);
            const color = CATEGORY_COLORS[cat];
            return (
              <button
                key={cat}
                type="button"
                className={`chip${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => toggleCategory(cat)}
              >
                <span
                  className="chip-dot"
                  style={on ? { background: color } : { border: `2px solid ${color}` }}
                />
                <span>{t(locale, cat)}</span>
                <span className="chip-count">{items.filter((i) => i.category === cat).length}</span>
              </button>
            );
          })}
        </div>

        <div className="control-group">
          <span className="control-label">{t(locale, "zoom")}</span>
          <div role="group" aria-label={t(locale, "zoom")} className="segmented">
            {ZOOM_PRESETS_YEARS.map((z) => {
              const on = Math.abs(z - span) < 0.5;
              return (
                <button
                  key={z}
                  type="button"
                  className={`seg num${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setZoom(z)}
                >
                  {z}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <main className="main">
        <Timeline
          items={visibleItems}
          categories={visibleCategories}
          start={start}
          end={end}
          now={NOW}
          locale={locale}
          selectedId={selected?.id ?? null}
          matchIds={matchIds}
          labelOf={labelOf}
          onSelect={select}
          onPanYears={onPanYears}
          onZoomAt={onZoomAt}
          onPanBack={() => panBy(-1)}
          onPanForward={() => panBy(1)}
          onNow={goNow}
        />
        <DetailPanel
          locale={locale}
          item={selected}
          detail={detail}
          concurrent={concurrent}
          nowYear={NOW_YEAR}
          labelOf={labelOf}
          onSelect={select}
        />
      </main>
    </div>
  );
}
