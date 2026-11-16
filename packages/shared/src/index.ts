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

/**
 * Domain: the field an item belongs to, one vocabulary for every category, so that e.g.
 * "music" can later cover Bach, the gramophone and Woodstock alike. Not a subdivision within
 * a lane (painting vs novel); that would be a separate field. "other" = looked up, no fit.
 * Currently filled for persons only (from their first fitting Wikidata occupation, or a
 * political office/noble title when none fits); null elsewhere.
 */
export const DOMAINS = [
  "politics",
  "science",
  "thought",
  "literature",
  "arts",
  "music",
  "film",
  "sport",
  "business",
  "other",
] as const;

export type Domain = (typeof DOMAINS)[number];

/**
 * Diversity in the person lane: each further person from the same domain counts this much
 * less (×0.5, ×0.25…), so the lane mixes politicians with scientists, artists and musicians
 * instead of showing only heads of state. The most notable person of each domain is unaffected.
 */
export const DOMAIN_DECAY = 0.5;

/**
 * Timeline selection: rank a pool of M = min(N × POOL_FACTOR, MAX_POOL) candidates per
 * category (score + domain decay), then weighted-sample down to N (= perCategory). The API
 * returns only the sampled N; the pool never goes to the client.
 *
 * Soft temperature (score ** t) and EXPLORE_FRACTION pull mid-tier in without a huge pool;
 * M stays capped so JS sampling stays cheap.
 */
export const POOL_FACTOR = 4;
export const MAX_POOL = 160;
/** weight ∝ score ** SCORE_TEMPERATURE (1 = linear / harsh; lower = more mix). */
export const SCORE_TEMPERATURE = 0.4;
/** Fraction of N reserved for items outside the hard top-N of the pool. */
export const EXPLORE_FRACTION = 0.3;

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
  /** Field the item belongs to (see DOMAINS); null = not determined (yet) or not applicable. */
  domain: Domain | null;
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
