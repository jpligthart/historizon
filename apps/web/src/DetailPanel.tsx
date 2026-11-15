import type { TimelineItem } from "@historizon/shared";
import { CATEGORY_COLORS, t, type Locale } from "./i18n";
import { formatPeriod, formatYearsCompact, isOngoing, isPoint } from "./timelineLayout";

const CONCURRENT_LIMIT = 10;

type Props = {
  locale: Locale;
  item: TimelineItem | null;
  /** Enriched item (with Wikipedia extract) once loaded; null while loading. */
  detail: TimelineItem | null;
  concurrent: TimelineItem[];
  nowYear: number;
  labelOf: (item: TimelineItem) => string;
  onSelect: (item: TimelineItem) => void;
};

function wikipediaHref(item: TimelineItem, locale: Locale, title: string): string {
  if (locale === "nl" && item.wikipediaUrlNl) return item.wikipediaUrlNl;
  if (locale === "en" && item.wikipediaUrl) return item.wikipediaUrl;
  return `https://${locale}.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}

export function DetailPanel({ locale, item, detail, concurrent, nowYear, labelOf, onSelect }: Props) {
  if (!item) {
    return (
      <aside className="detail" aria-label={t(locale, "detail")}>
        <span className="detail-empty">{t(locale, "emptyHint")}</span>
      </aside>
    );
  }

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
    <aside className="detail" aria-label={t(locale, "detail")}>
      <div className="detail-cat">
        <span className="dot" style={{ background: color }} />
        <span>{t(locale, item.category)}</span>
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
        <p className="detail-text">{description || t(locale, "noExtract")}</p>
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
