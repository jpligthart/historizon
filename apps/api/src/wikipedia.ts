const DEFAULT_UA =
  "Historizon/0.1 (https://github.com/example/historizon; contact@example.com)";

function userAgent(): string {
  return process.env.WIKI_USER_AGENT?.trim() || DEFAULT_UA;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch a short plain-text extract from the MediaWiki API. Cached by caller. */
export async function fetchWikipediaExtract(
  titleOrUrl: string,
  lang = "en",
): Promise<{ extract: string; url: string } | null> {
  let title = titleOrUrl;
  try {
    if (titleOrUrl.startsWith("http")) {
      const u = new URL(titleOrUrl);
      const parts = u.pathname.split("/");
      title = decodeURIComponent(parts[parts.length - 1] ?? "");
    }
  } catch {
    return null;
  }

  if (!title) return null;

  const endpoint = `https://${lang}.wikipedia.org/w/api.php`;
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    inprop: "url",
    titles: title,
    format: "json",
    origin: "*",
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${endpoint}?${params}`, {
      headers: {
        "User-Agent": userAgent(),
        Accept: "application/json",
      },
    });

    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;

    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          { extract?: string; fullurl?: string; missing?: string }
        >;
      };
    };

    const pages = data.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined || !page.extract) return null;

    const extract = page.extract.trim().slice(0, 600);
    return {
      extract: extract.length < page.extract.trim().length ? `${extract}…` : extract,
      url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  }

  return null;
}

/**
 * Minimal Wikidata SPARQL sample ingest — polite, limited, for expansion.
 * Prefer dumps for large backfills.
 */
export async function sparqlSample(limit = 50): Promise<
  Array<{
    id: string;
    title: string;
    startYear: number;
    endYear: number | null;
    wikidataId: string;
    wikipediaUrl: string | null;
  }>
> {
  const query = `
SELECT ?item ?itemLabel ?start ?end ?article WHERE {
  ?item wdt:P31/wdt:P279* wd:Q198 .
  OPTIONAL { ?item wdt:P580 ?start . }
  OPTIONAL { ?item wdt:P582 ?end . }
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  FILTER(BOUND(?start))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${Math.min(Math.max(limit, 1), 100)}
`.trim();

  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent(),
      Accept: "application/sparql-results+json",
    },
  });

  if (!res.ok) {
    throw new Error(`Wikidata SPARQL failed: ${res.status}`);
  }

  const json = (await res.json()) as {
    results: {
      bindings: Array<{
        item: { value: string };
        itemLabel: { value: string };
        start?: { value: string };
        end?: { value: string };
        article?: { value: string };
      }>;
    };
  };

  return json.results.bindings
    .map((b) => {
      const wikidataId = b.item.value.split("/").pop() ?? "";
      const startYear = b.start ? Number(b.start.value.slice(0, 4)) : NaN;
      const endYear = b.end ? Number(b.end.value.slice(0, 4)) : null;
      if (!wikidataId || Number.isNaN(startYear)) return null;
      return {
        id: `wd-${wikidataId}`,
        title: b.itemLabel.value,
        startYear,
        endYear: endYear !== null && !Number.isNaN(endYear) ? endYear : null,
        wikidataId,
        wikipediaUrl: b.article?.value ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
