import type { Category, TimelineItem, TimelineMeta } from "@historizon/shared";

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
}): Promise<TimelineItem[]> {
  const params = new URLSearchParams({
    from: String(Math.floor(opts.from)),
    to: String(Math.ceil(opts.to)),
  });
  if (opts.categories?.length) params.set("categories", opts.categories.join(","));
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  if (opts.limit) params.set("limit", String(opts.limit));

  const res = await fetch(`/api/items?${params}`);
  if (!res.ok) throw new Error("Failed to load items");
  const data = (await res.json()) as { items: TimelineItem[] };
  return data.items;
}

export async function fetchItem(id: string): Promise<TimelineItem> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to load item");
  const data = (await res.json()) as { item: TimelineItem };
  return data.item;
}
