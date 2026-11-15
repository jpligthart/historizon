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

/** Fetch a short plain-text intro extract from the MediaWiki API. Cached by caller. */
export async function fetchWikipediaExtract(
  titleOrUrl: string,
  lang: WikiLang = "en",
): Promise<{ extract: string; url: string } | null> {
  const title = titleFromUrl(titleOrUrl);
  if (!title) return null;

  const params = new URLSearchParams({
    action: "query",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    inprop: "url",
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
    query?: { pages?: Array<{ extract?: string; fullurl?: string; missing?: boolean }> };
  };
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;

  const full = page.extract.trim();
  const extract = full.slice(0, 600);
  return {
    extract: extract.length < full.length ? `${extract}…` : extract,
    url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

/**
 * Full-text search on Wikipedia; returns the Wikidata ids of the hits in relevance order.
 * One request: generator=search + pageprops.
 */
export async function searchWikipedia(q: string, lang: WikiLang, limit = 12): Promise<string[]> {
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
    query?: { pages?: Array<{ index?: number; pageprops?: { wikibase_item?: string } }> };
  };
  return (data.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => p.pageprops?.wikibase_item)
    .filter((x): x is string => !!x);
}
