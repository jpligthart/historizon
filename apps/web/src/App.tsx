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
import { DetailPanel } from "./DetailPanel";

/** AGPL §13: users interacting over a network must be offered the source. */
const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || "https://github.com/jpligthart/historizon";
const JELPH_ME_URL = "https://ko-fi.com/jelphme";
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
/**
 * "Rijen" setting: rows per lane, and how many of the most notable items per category to
 * load for it (more rows need more items to fill them).
 */
const ROW_PRESETS = [
  { key: "compact", rows: 4, perCategory: 20 },
  { key: "normal", rows: 6, perCategory: 25 },
  { key: "roomy", rows: 10, perCategory: 40 },
  { key: "max", rows: 15, perCategory: 60 },
] as const;
type RowPreset = (typeof ROW_PRESETS)[number]["key"];
const ROWS_KEY = "historizon.rows";

function readRowsPref(): RowPreset {
  try {
    const v = localStorage.getItem(ROWS_KEY);
    return ROW_PRESETS.find((p) => p.key === v)?.key ?? "normal";
  } catch {
    return "normal";
  }
}

function writeRowsPref(preset: RowPreset): void {
  try {
    localStorage.setItem(ROWS_KEY, preset);
  } catch {
    // Storage blocked (private mode): the choice just isn't remembered.
  }
}
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
  const [rowsPref, setRowsPref] = useState<RowPreset>(readRowsPref);
  const rowPreset = ROW_PRESETS.find((p) => p.key === rowsPref) ?? ROW_PRESETS[1];
  const chooseRows = (preset: RowPreset) => {
    setRowsPref(preset);
    writeRowsPref(preset);
  };
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
  const [detailFailed, setDetailFailed] = useState(false);
  const [concurrentAll, setConcurrentAll] = useState<TimelineItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [wikiPaused, setWikiPaused] = useState(false);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [refreshTick, setRefreshTick] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Esc closes about, then menu, then the detail panel (search handles its own Esc).
  useEffect(() => {
    if (!selected && !aboutOpen && !menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || el?.closest("input, textarea, select")) return;
      if (aboutOpen) {
        setAboutOpen(false);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, aboutOpen, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

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
      fetchItems({ from: start, to: end, limit: 2000, perCategory: rowPreset.perCategory, discover: true, lens: lensOn ? "nl" : null, signal: ctrl.signal })
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
  }, [start, end, refreshTick, lensOn, rowPreset.perCategory]);

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
    if (!selected) {
      setDetail(null);
      setDetailFailed(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setDetailFailed(false);
    fetchItem(selected.id, locale, ctrl.signal)
      .then((item) => {
        if (!cancelled) {
          setDetail(item);
          setDetailFailed(false);
        }
      })
      .catch((err) => {
        if (cancelled || ctrl.signal.aborted) return;
        console.error(err);
        // Show the list item so the panel does not stick on the skeleton.
        setDetail(selected);
        setDetailFailed(true);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [selected?.id, locale]);

  // Extra overlaps from outside the current viewport (API); merged with on-screen items below.
  useEffect(() => {
    if (!selected) {
      setConcurrentAll([]);
      return;
    }
    // Point / closed span: query that lifespan. Ongoing (null end): through "now".
    const to = selected.endYear ?? NOW_YEAR;
    let cancelled = false;
    fetchItems({ from: selected.startYear, to, limit: 2000, perCategory: 15, lens: lensOn ? "nl" : null })
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
  // Tegelijk: overlaps in time — always fold in what's already loaded in view, plus the
  // wider API fetch (outside the current zoom). Both sides are overlap-filtered.
  const concurrent = useMemo(() => {
    if (!selected) return [];
    const selEnd = selected.endYear ?? NOW;
    const overlaps = (i: TimelineItem) => {
      const iEnd = i.endYear ?? NOW;
      return i.startYear <= selEnd && selected.startYear <= iEnd;
    };
    const byId = new Map<string, TimelineItem>();
    for (const i of concurrentAll) {
      if (overlaps(i)) byId.set(i.id, i);
    }
    for (const i of items) {
      if (overlaps(i)) byId.set(i.id, i);
    }
    return [...byId.values()]
      .filter((i) => i.id !== selected.id && !hidden.has(i.category))
      .sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.startYear - b.startYear);
  }, [concurrentAll, items, selected, hidden]);

  const select = useCallback((item: TimelineItem) => {
    setDetail(null);
    setDetailFailed(false);
    setSelected(item);
  }, []);

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
    setDetail(null);
    setDetailFailed(false);
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
            <div className="brand-text">
              <h1>{t(locale, "brand")}</h1>
              <span className="tagline">{t(locale, "tagline")}</span>
            </div>
          </div>
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
        <div className="menu" ref={menuRef}>
          <button
            type="button"
            className="menu-btn"
            aria-expanded={menuOpen}
            aria-controls="app-menu"
            aria-label={t(locale, "menu")}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          {menuOpen && (
            <div id="app-menu" className="menu-panel" role="menu">
              <div className="menu-row">
                <span className="menu-label">{t(locale, "language")}</span>
                <div role="group" aria-label={t(locale, "language")} className="segmented">
                  {(["nl", "en"] as const).map((lg) => (
                    <button
                      key={lg}
                      type="button"
                      role="menuitemradio"
                      className={`seg${locale === lg ? " on" : ""}`}
                      aria-checked={locale === lg}
                      onClick={() => setLocale(lg)}
                    >
                      {lg.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="menu-row">
                <span className="menu-label">{t(locale, "rows")}</span>
                <div role="group" aria-label={t(locale, "rowsHint")} className="segmented">
                  {ROW_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      role="menuitemradio"
                      className={`seg${rowsPref === p.key ? " on" : ""}`}
                      aria-checked={rowsPref === p.key}
                      title={`${p.rows} ${t(locale, "rowsUnit")}`}
                      onClick={() => chooseRows(p.key)}
                    >
                      {t(locale, `rows_${p.key}`)}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setAboutOpen(true);
                }}
              >
                {t(locale, "aboutTitle")}
              </button>
            </div>
          )}
        </div>
      </header>

      {aboutOpen && (
        <div className="about-backdrop" onPointerDown={() => setAboutOpen(false)}>
          <div
            id="about-panel"
            className="about-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="about-head">
              <div className="about-brand">
                <svg width="36" height="36" viewBox="0 0 28 28" aria-hidden="true">
                  <rect x="2" y="5" width="16" height="5" rx="2.5" fill="#0F766E" />
                  <rect x="8" y="12" width="18" height="5" rx="2.5" fill="#1D4ED8" />
                  <rect x="5" y="19" width="12" height="5" rx="2.5" fill="#B91C1C" />
                </svg>
                <div className="about-brand-text">
                  <h2 id="about-title">{t(locale, "aboutTitle")}</h2>
                  <p className="about-tagline">{t(locale, "tagline")}</p>
                </div>
              </div>
              <button
                type="button"
                className="about-close"
                aria-label={t(locale, "closeDetail")}
                onClick={() => setAboutOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <p className="about-blurb">{t(locale, "aboutBlurb")}</p>

            <section className="about-section" aria-labelledby="about-sources-heading">
              <h3 id="about-sources-heading" className="about-section-label">
                {t(locale, "aboutSources")}
              </h3>
              <ul className="about-links">
                <li>
                  <a href="https://www.wikidata.org/" target="_blank" rel="noreferrer" className="about-link">
                    <span>
                      <span className="about-link-title">{t(locale, "aboutWikidata")}</span>
                      <span className="about-link-desc">{t(locale, "aboutWikidataDesc")}</span>
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17L17 7M10 7h7v7" />
                    </svg>
                  </a>
                </li>
                <li>
                  <a href="https://www.wikipedia.org/" target="_blank" rel="noreferrer" className="about-link">
                    <span>
                      <span className="about-link-title">{t(locale, "aboutWikipedia")}</span>
                      <span className="about-link-desc">{t(locale, "aboutWikipediaDesc")}</span>
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17L17 7M10 7h7v7" />
                    </svg>
                  </a>
                </li>
                <li>
                  <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="about-link">
                    <span>
                      <span className="about-link-title">{t(locale, "aboutSource")}</span>
                      <span className="about-link-desc">{t(locale, "aboutSourceDesc")}</span>
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17L17 7M10 7h7v7" />
                    </svg>
                  </a>
                </li>
              </ul>
            </section>

            <section className="about-section" aria-labelledby="about-support-heading">
              <h3 id="about-support-heading" className="about-section-label">
                {t(locale, "aboutSupport")}
              </h3>
              <a href={JELPH_ME_URL} target="_blank" rel="noreferrer" className="about-tip">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 21s-6.5-4.3-9-8.2C1.2 9.8 2.6 6.5 6 6c1.8-.3 3.5.6 4.5 2 1-1.4 2.7-2.3 4.5-2 3.4.5 4.8 3.8 3 6.8C18.5 16.7 12 21 12 21z" />
                </svg>
                {t(locale, "aboutTip")}
              </a>
            </section>
          </div>
        </div>
      )}

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
          maxRows={rowPreset.rows}
          onZoom={setZoom}
          loadingMore={loadingMore}
          wikiPaused={wikiPaused}
        />
        {selected && (
          <DetailPanel
            locale={locale}
            item={selected}
            detail={detail}
            detailFailed={detailFailed}
            concurrent={concurrent}
            nowYear={NOW_YEAR}
            labelOf={labelOf}
            onSelect={select}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}
