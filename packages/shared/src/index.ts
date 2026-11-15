export const CATEGORIES = [
  "person",
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
