/** Display order = lane order. "state" = empires, states, dynasties; "period" = eras. */
export const CATEGORIES = [
  "person",
  "state",
  "period",
  "event",
  "war",
  "invention",
  "artwork",
  "place",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const ZOOM_PRESETS_YEARS = [10, 25, 50, 100, 250, 500] as const;
export const DEFAULT_ZOOM_YEARS = 50;

/**
 * Nederland-bril: items with a Dutch connection rank this many times higher. Dutch topics
 * have far fewer language editions than global ones (Annie M.G. Schmidt ±30 vs Obama ±340);
 * ×2.5 mixes them in (Rembrandt, Vermeer next to Galilei and Newton) instead of crowding the
 * global names out, as ×4 did for the Golden Age.
 */
export const NL_BOOST = 2.5;

/** Integer year; negative = BCE. */
export type Year = number;

export interface TimelineItem {
  id: string;
  title: string;
  titleNl: string | null;
  category: Category;
  startYear: Year;
  endYear: Year | null;
  description: string | null;
  descriptionNl: string | null;
  wikipediaUrl: string | null;
  wikipediaUrlNl: string | null;
  wikidataId: string | null;
  /** True when the description is a cached Wikipedia extract (CC BY-SA 4.0, needs attribution). */
  descriptionFromWikipedia: boolean;
  /** Notability (Wikipedia sitelink count); null for curated items without a Wikidata link. */
  importance: number | null;
  /** Has a Dutch connection (nationality, location, maker, origin…); null = not yet known. */
  nlLink: boolean | null;
}

export interface TimelineQuery {
  from: Year;
  to: Year;
  categories?: Category[];
  q?: string;
  limit?: number;
}

export interface TimelineMeta {
  minYear: Year;
  maxYear: Year;
  count: number;
  categories: Category[];
  zoomPresets: readonly number[];
  defaultZoomYears: number;
}

export interface HealthResponse {
  status: "ok";
  service: "historizon-api";
}
