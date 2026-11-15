import type { Category, TimelineItem, TimelineMeta } from "@historizon/shared";
import type { Locale } from "./i18n";

export async function fetchMeta(): Promise<TimelineMeta> {
  const res = await fetch("/api/meta");
  if (!res.ok) throw new Error("Failed to load meta");
  return res.json();
}

export async function fetchItems(opts: {
  from: number;
  to: number;
  categories?: Category[];
  q?: string;
  limit?: number;
  /** Max items per category (most notable first). */
  perCategory?: number;
  /** Ask the server to discover more items for this range on Wikidata. */
  discover?: boolean;
  /** "nl": Nederland-bril (Dutch items rank higher; Dutch tiles are fetched too). */
  lens?: "nl" | null;
  signal?: AbortSignal;
}): Promise<{ items: TimelineItem[]; pending: number }> {
  const params = new URLSearchParams({
    from: String(Math.floor(opts.from)),
    to: String(Math.ceil(opts.to)),
  });
  if (opts.categories?.length) params.set("categories", opts.categories.join(","));
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.perCategory) params.set("perCategory", String(opts.perCategory));
  if (opts.discover) params.set("fetch", "1");
  if (opts.lens) params.set("lens", opts.lens);

  const res = await fetch(`/api/items?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error("Failed to load items");
  const data = (await res.json()) as { items: TimelineItem[]; pending?: number };
  return { items: data.items, pending: data.pending ?? 0 };
}

export type SearchResult = {
  items: TimelineItem[];
  remote: "cached" | "fetched" | "failed" | "skipped";
};

/** Searches Wikipedia (via the API, cached) plus the local database; relevance order. */
export async function searchItems(q: string, lang: Locale, signal?: AbortSignal): Promise<SearchResult> {
  const params = new URLSearchParams({ q, lang });
  const res = await fetch(`/api/search?${params}`, { signal });
  if (!res.ok) throw new Error("Search failed");
  return res.json();
}

export async function fetchItem(id: string, lang: Locale): Promise<TimelineItem> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}?lang=${lang}`);
  if (!res.ok) throw new Error("Failed to load item");
  const data = (await res.json()) as { item: TimelineItem };
  return data.item;
}
