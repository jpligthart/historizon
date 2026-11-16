import { politeFetch, throttles } from "./throttle.js";

export type WikiLang = "en" | "nl";

function titleFromUrl(titleOrUrl: string): string | null {
  if (!titleOrUrl.startsWith("http")) return titleOrUrl;
  try {
    const parts = new URL(titleOrUrl).pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1] ?? "") || null;
  } catch {
    return null;
  }
}

/** Fetch a short plain-text intro extract (+ optional lead thumbnail URL). Cached by caller. */
export async function fetchWikipediaExtract(
  titleOrUrl: string,
  lang: WikiLang = "en",
): Promise<{ extract: string; url: string; imageUrl: string | null } | null> {
  const title = titleFromUrl(titleOrUrl);
  if (!title) return null;

  const params = new URLSearchParams({
    action: "query",
    prop: "extracts|info|pageimages",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    inprop: "url",
    // URL only — browser loads from Wikimedia; we never store the bytes.
    piprop: "thumbnail",
    pithumbsize: "320",
    pilicense: "any",
    titles: title,
    format: "json",
    formatversion: "2",
  });

  const res = await politeFetch(throttles.wikipedia, `https://${lang}.wikipedia.org/w/api.php?${params}`, {
    headers: { Accept: "application/json" },
    // A user is waiting: return local results rather than sit out a long back-off.
    maxWaitMs: 3000,
    retries: 1,
  });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    query?: {
      pages?: Array<{
        extract?: string;
        fullurl?: string;
        missing?: boolean;
        thumbnail?: { source?: string };
      }>;
    };
  };
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;

  const full = page.extract.trim();
  const extract = full.slice(0, 600);
  const imageUrl = page.thumbnail?.source?.trim() || null;
  return {
    extract: extract.length < full.length ? `${extract}…` : extract,
    url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    imageUrl,
  };
}

export type SearchHit = { qid: string; title: string };

/**
 * Full-text search on Wikipedia; returns the hits (Wikidata id + page title) in relevance
 * order. One request: generator=search + pageprops.
 */
export async function searchWikipedia(q: string, lang: WikiLang, limit = 12): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: q,
    gsrlimit: String(limit),
    gsrnamespace: "0",
    prop: "pageprops",
    ppprop: "wikibase_item",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  const res = await politeFetch(throttles.wikipedia, `https://${lang}.wikipedia.org/w/api.php?${params}`, {
    headers: { Accept: "application/json" },
    // A user is waiting: return local results rather than sit out a long back-off.
    maxWaitMs: 3000,
    retries: 1,
  });
  if (!res.ok) throw new Error(`Wikipedia search ${res.status}`);
  const data = (await res.json()) as {
    query?: { pages?: Array<{ index?: number; title: string; pageprops?: { wikibase_item?: string } }> };
  };
  return (data.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((p) => !!p.pageprops?.wikibase_item)
    .map((p) => ({ qid: p.pageprops!.wikibase_item!, title: p.title }));
}

/**
 * Resolve Wikipedia article URLs to their Wikidata ids, following redirects (articles get
 * renamed; the old URL then redirects). Up to 50 per request.
 */
export async function resolveWikidataIds(
  urls: string[],
  lang: WikiLang = "en",
): Promise<Map<string, { qid: string; url: string }>> {
  const out = new Map<string, { qid: string; url: string }>();
  for (let i = 0; i < urls.length; i += 50) {
    const batch = urls.slice(i, i + 50);
    const titleByUrl = new Map(batch.map((u) => [u, titleFromUrl(u)]));
    const titles = [...new Set([...titleByUrl.values()].filter((t): t is string => !!t))];
    if (titles.length === 0) continue;
    const params = new URLSearchParams({
      action: "query",
      titles: titles.join("|"),
      redirects: "1",
      prop: "pageprops|info",
      ppprop: "wikibase_item",
      inprop: "url",
      format: "json",
      formatversion: "2",
    });
    const res = await politeFetch(throttles.wikipedia, `https://${lang}.wikipedia.org/w/api.php?${params}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Wikipedia resolve ${res.status}`);
    const data = (await res.json()) as {
      query?: {
        normalized?: Array<{ from: string; to: string }>;
        redirects?: Array<{ from: string; to: string }>;
        pages?: Array<{ title: string; fullurl?: string; pageprops?: { wikibase_item?: string } }>;
      };
    };
    const q = data.query ?? {};
    const follow = (t: string) => {
      const norm = q.normalized?.find((n) => n.from === t)?.to ?? t;
      return q.redirects?.find((r) => r.from === norm)?.to ?? norm;
    };
    for (const [url, title] of titleByUrl) {
      if (!title) continue;
      const page = q.pages?.find((p) => p.title === follow(title));
      const qid = page?.pageprops?.wikibase_item;
      if (qid) out.set(url, { qid, url: page.fullurl ?? url });
    }
  }
  return out;
}
