import { useEffect, useRef } from "react";
import type { TimelineItem } from "@historizon/shared";
import { CATEGORY_COLORS, t, type Locale } from "./i18n";
import { formatPeriod, formatYearsCompact, isOngoing, isPoint } from "./timelineLayout";

const CONCURRENT_LIMIT = 10;
export const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

type Props = {
  locale: Locale;
  item: TimelineItem;
  /** Enriched item (with Wikipedia extract) once loaded; null while loading. */
  detail: TimelineItem | null;
  concurrent: TimelineItem[];
  nowYear: number;
  labelOf: (item: TimelineItem) => string;
  onSelect: (item: TimelineItem) => void;
  onClose: () => void;
};

function wikipediaHref(item: TimelineItem, locale: Locale, title: string): string {
  if (locale === "nl" && item.wikipediaUrlNl) return item.wikipediaUrlNl;
  if (locale === "en" && item.wikipediaUrl) return item.wikipediaUrl;
  return `https://${locale}.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}

/** Shown only while something is selected; slides in next to the timeline. */
export function DetailPanel({ locale, item, detail, concurrent, nowYear, labelOf, onSelect, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);
  // A new selection starts at the top of the panel (no re-mount, so no repeated slide-in).
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [item.id]);

  const bce = t(locale, "bce");
  const name = labelOf(item);
  const color = CATEGORY_COLORS[item.category];
  const duration = isOngoing(item)
    ? nowYear - item.startYear
    : (item.endYear as number) - item.startYear;
  const loaded = detail !== null && detail.id === item.id;
  const description = loaded
    ? (locale === "nl" ? detail.descriptionNl : null) || detail.description || ""
    : "";

  return (
    <aside ref={ref} className="detail" aria-label={t(locale, "detail")}>
      <div className="detail-head">
        <div className="detail-cat">
          <span className="dot" style={{ background: color }} />
          <span>{t(locale, item.category)}</span>
        </div>
        <button
          type="button"
          className="close-btn"
          onClick={onClose}
          aria-label={t(locale, "closeDetail")}
          title={t(locale, "closeDetail")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <h2 className="detail-title">{name}</h2>
      <div className="pills">
        <span className="pill">{formatPeriod(item, t(locale, "present"), bce)}</span>
        {!isPoint(item) && (
          <span className="pill muted">
            {duration} {t(locale, "years")}
          </span>
        )}
      </div>

      {loaded ? (
        <div className="detail-body">
          <p className="detail-text">{description || t(locale, "noExtract")}</p>
          {description && detail.descriptionFromWikipedia && (
            <p className="attribution">
              {t(locale, "sourcePrefix")}{" "}
              <a href={detail.wikipediaUrl ?? wikipediaHref(item, "en", item.title)} target="_blank" rel="noreferrer">
                Wikipedia
              </a>
              {", "}
              {t(locale, "licensedUnder")}{" "}
              <a href={CC_BY_SA_URL} target="_blank" rel="noreferrer">
                CC BY-SA 4.0
              </a>
            </p>
          )}
        </div>
      ) : (
        <div className="skeleton" aria-busy="true">
          <div style={{ width: "100%" }} />
          <div style={{ width: "92%" }} />
          <div style={{ width: "64%" }} />
          <span>{t(locale, "extractNote")}</span>
        </div>
      )}

      <a className="wiki-btn" href={wikipediaHref(item, locale, name)} target="_blank" rel="noreferrer">
        {t(locale, "openWikipedia")}
      </a>

      <div className="divider" />

      <div className="concurrent">
        <div className="concurrent-head">
          <h3>{t(locale, "concurrent")}</h3>
          <span className="count-badge">{concurrent.length}</span>
        </div>
        <div className="concurrent-list">
          {concurrent.slice(0, CONCURRENT_LIMIT).map((c) => (
            <button key={c.id} type="button" className="row" onClick={() => onSelect(c)}>
              <span className="dot" style={{ background: CATEGORY_COLORS[c.category] }} />
              <span className="row-name">{labelOf(c)}</span>
              <span className="row-years">{formatYearsCompact(c, bce)}</span>
            </button>
          ))}
        </div>
        {concurrent.length > CONCURRENT_LIMIT && (
          <span className="more">
            + {concurrent.length - CONCURRENT_LIMIT} {t(locale, "more")}
          </span>
        )}
      </div>
    </aside>
  );
}
