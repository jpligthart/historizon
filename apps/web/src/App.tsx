import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CATEGORIES,
  DEFAULT_ZOOM_YEARS,
  NL_BOOST,
  ZOOM_PRESETS_YEARS,
  type Category,
  type TimelineItem,
  type TimelineMeta,
} from "@historizon/shared";
import { fetchItem, fetchItems, fetchMeta, searchItems } from "./api";
import { Timeline } from "./Timeline";
import { CC_BY_SA_URL, DetailPanel } from "./DetailPanel";

/** AGPL §13: users interacting over a network must be offered the source. */
const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || "https://github.com/jpligthart/historizon";
import { CATEGORY_COLORS, t, type Locale } from "./i18n";
import { formatYearsCompact } from "./timelineLayout";

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
/** Most notable items per category in view (level of detail). */
const PER_CATEGORY = 25;
const POLL_MS = 1500;
/** Search results shown in the dropdown. */
const MAX_RESULTS = 8;

const LENS_KEY = "historizon.nlLens";

/** Stored Nederland-bril choice; null = never chosen (then it follows the language). */
function readLensPref(): boolean | null {
  try {
    const v = localStorage.getItem(LENS_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function writeLensPref(on: boolean): void {
  try {
    localStorage.setItem(LENS_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked (private mode): the choice just isn't remembered.
  }
}
const MAX_POLLS = 40;
const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<Category, number>;

export function App() {
  const [locale, setLocale] = useState<Locale>("nl");
  // Nederland-bril: follows the language (on for NL, off for EN) until the user picks.
  const [lensPref, setLensPref] = useState<boolean | null>(readLensPref);
  const lensOn = lensPref ?? locale === "nl";
  const toggleLens = () => {
    const next = !lensOn;
    setLensPref(next);
    writeLensPref(next);
  };
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [wikiPaused, setWikiPaused] = useState(false);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [refreshTick, setRefreshTick] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Esc closes the detail panel (the search field handles its own Esc).
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || el?.closest("input, textarea, select")) return;
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const clearSearch = () => {
    setQuery("");
    setMatches([]);
    setSearchState("idle");
    setListOpen(false);
    searchRef.current?.focus();
  };

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
  // hidden categories are filtered out client-side. The server discovers more items on
  // Wikidata for this range in the background; while it reports pending tiles we poll.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer = 0;
    let polls = 0;
    const load = () => {
      fetchItems({ from: start, to: end, limit: 2000, perCategory: PER_CATEGORY, discover: true, lens: lensOn ? "nl" : null, signal: ctrl.signal })
        .then(({ items: next, pending, pausedMs }) => {
          setItems(next);
          const paused = pausedMs > 0;
          // While SPARQL is paused, keep polling without burning the poll budget.
          const more = pending > 0 && (paused || polls < MAX_POLLS);
          setLoadingMore(more);
          setWikiPaused(more && paused);
          if (more) {
            if (!paused) polls++;
            timer = window.setTimeout(load, POLL_MS);
          }
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) console.error(err);
        });
    };
    timer = window.setTimeout(load, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [start, end, refreshTick, lensOn]);

  // Search: Wikipedia (via the API, cached server-side) + local database, relevance order.
  useEffect(() => {
    if (deferredQuery.length < 2) {
      setMatches([]);
      setSearchState("idle");
      return;
    }
    const ctrl = new AbortController();
    const handle = window.setTimeout(() => {
      setSearchState("searching");
      searchItems(deferredQuery, locale, ctrl.signal)
        .then(({ items: found, remote }) => {
          setMatches(found);
          setSearchState(remote === "failed" ? "failed" : "done");
          // New items may have landed in the database; refresh the timeline.
          if (remote === "fetched") setRefreshTick((n) => n + 1);
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) {
            console.error(err);
            setSearchState("failed");
          }
        });
    }, 350);
    return () => {
      ctrl.abort();
      window.clearTimeout(handle);
    };
  }, [deferredQuery, locale]);

  // Enriched detail (Wikipedia extract, in the UI language when available).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetchItem(selected.id, locale)
      .then((item) => {
        if (!cancelled) setDetail(item);
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [selected?.id, locale]);

  // Everything that overlaps the selected item in time.
  useEffect(() => {
    if (!selected) {
      setConcurrentAll([]);
      return;
    }
    let cancelled = false;
    fetchItems({ from: selected.startYear, to: selected.endYear ?? NOW_YEAR, limit: 2000, perCategory: 15, lens: lensOn ? "nl" : null })
      .then(({ items: next }) => {
        if (!cancelled) setConcurrentAll(next);
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.startYear, selected?.endYear, lensOn]);

  const labelOf = useCallback(
    (item: TimelineItem) => (locale === "nl" && item.titleNl ? item.titleNl : item.title),
    [locale],
  );

  const visibleCategories = useMemo(() => CATEGORIES.filter((c) => !hidden.has(c)), [hidden]);
  const visibleItems = useMemo(() => {
    const list = items.filter((i) => !hidden.has(i.category));
    // The selection may be less notable than the top-N the server returns; keep it visible.
    if (
      selected &&
      !hidden.has(selected.category) &&
      selected.startYear <= end &&
      (selected.endYear ?? NOW) >= start &&
      !list.some((i) => i.id === selected.id)
    ) {
      list.push(selected);
    }
    return list;
  }, [items, hidden, selected, start, end]);
  // Relevance order (best Wikipedia hit first), so "jump" goes to the most likely match.
  const visibleMatches = useMemo(() => matches.filter((i) => !hidden.has(i.category)), [matches, hidden]);
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

  /** Center the timeline on an item and select it. */
  const jumpTo = (m: TimelineItem) => {
    const mid = (m.startYear + (m.endYear ?? NOW)) / 2;
    setView((v) => ({ ...v, end: clampEnd(v.span, mid + v.span / 2) }));
    setSelected(m);
  };

  const showSearchStatus = deferredQuery.length >= 2 && searchState !== "idle";
  const resultList = visibleMatches.slice(0, MAX_RESULTS);
  const listVisible = listOpen && resultList.length > 0;

  const pickResult = (m: TimelineItem) => {
    jumpTo(m);
    setListOpen(false);
  };

  // Reset the highlighted option whenever the results change.
  useEffect(() => setActiveIndex(0), [matches]);

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (resultList.length === 0) return;
      e.preventDefault();
      if (!listOpen) {
        setListOpen(true);
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i + delta + resultList.length) % resultList.length);
    } else if (e.key === "Enter") {
      const m = resultList[listOpen ? activeIndex : 0];
      if (m) pickResult(m);
    } else if (e.key === "Escape") {
      // First Esc closes the list, a second one clears the field.
      if (listVisible) setListOpen(false);
      else if (query) clearSearch();
    }
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
        <div className={`search${showSearchStatus ? " has-status" : query ? " has-clear" : ""}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listVisible}
            aria-controls="search-results"
            aria-activedescendant={listVisible ? `search-opt-${activeIndex}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setListOpen(true);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onKeyDown={onSearchKeyDown}
            placeholder={t(locale, "searchPlaceholder")}
            aria-label={t(locale, "search")}
          />
          {/* Status lives inside the field so the toolbar never reflows while searching. */}
          {(showSearchStatus || query) && (
            <div className="search-status" aria-live="polite">
              {showSearchStatus && searchState === "searching" && <span className="spinner" aria-hidden="true" />}
              {!showSearchStatus ? null : visibleMatches.length > 0 ? (
                <button
                  type="button"
                  className="count-btn"
                  aria-expanded={listVisible}
                  aria-controls="search-results"
                  // Keep focus in the input so the list doesn't close on blur first.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setListOpen((o) => !o)}
                >
                  {visibleMatches.length} {t(locale, "matches")}
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={listVisible ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              ) : (
                <span className="search-count">
                  {searchState === "searching" ? t(locale, "searchingShort") : t(locale, "noMatches")}
                </span>
              )}
              {showSearchStatus && searchState === "failed" && (
                <span className="search-warn" role="img" title={t(locale, "searchOffline")} aria-label={t(locale, "searchOffline")}>
                  !
                </span>
              )}
              {query && (
                <button
                  type="button"
                  className="clear-btn"
                  aria-label={t(locale, "clearSearch")}
                  title={t(locale, "clearSearch")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearch}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {listVisible && (
            <ul id="search-results" role="listbox" className="search-results" aria-label={t(locale, "search")}>
              {resultList.map((m, i) => (
                <li
                  key={m.id}
                  id={`search-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`result${i === activeIndex ? " active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pickResult(m)}
                >
                  <span className="dot" style={{ background: CATEGORY_COLORS[m.category] }} />
                  <span className="result-name">{labelOf(m)}</span>
                  <span className="result-meta">
                    {t(locale, m.category)} · {formatYearsCompact(m, t(locale, "bce"))}
                  </span>
                </li>
              ))}
              {visibleMatches.length > resultList.length && (
                <li className="result-more" aria-hidden="true">
                  + {visibleMatches.length - resultList.length} {t(locale, "more")}
                </li>
              )}
            </ul>
          )}
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
        <div className="chips-scroll">
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
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className={`lens-toggle${lensOn ? " on" : ""}`}
          role="switch"
          aria-checked={lensOn}
          onClick={toggleLens}
          title={t(locale, "nlLensHint")}
        >
          <span className="lens-track" aria-hidden="true">
            <span className="lens-knob" />
          </span>
          {t(locale, "nlLens")}
        </button>
      </div>

      <main className={`main${selected ? " with-detail" : ""}`}>
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
          zoomPresets={ZOOM_PRESETS_YEARS}
          nlBoost={lensOn ? NL_BOOST : 1}
          onZoom={setZoom}
          loadingMore={loadingMore}
          wikiPaused={wikiPaused}
        />
        {selected && (
          <DetailPanel
            locale={locale}
            item={selected}
            detail={detail}
            concurrent={concurrent}
            nowYear={NOW_YEAR}
            labelOf={labelOf}
            onSelect={select}
            onClose={() => setSelected(null)}
          />
        )}
      </main>

      <footer className="footer">
        <span>
          {t(locale, "freeSoftware")}{" "}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>
          {" · "}
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            {t(locale, "sourceCode")}
          </a>
        </span>
        <span>
          {t(locale, "footerWiki")}{" "}
          <a href={CC_BY_SA_URL} target="_blank" rel="noreferrer">
            CC BY-SA 4.0
          </a>
        </span>
      </footer>
    </div>
  );
}
