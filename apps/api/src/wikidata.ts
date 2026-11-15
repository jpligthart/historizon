import type { Category } from "@historizon/shared";
import { politeFetch, throttles } from "./throttle.js";

/**
 * Wikidata via SPARQL. The public Wikidata Query Service times out on the
 * "most notable X in period Y" queries we need, so the default endpoint is QLever
 * (University of Freiburg), which serves the same Wikidata graph and answers these
 * in about 0.5–4 s. Override with WIKIDATA_SPARQL_URL.
 */
const SPARQL_URL = process.env.WIKIDATA_SPARQL_URL?.trim() || "https://qlever.dev/api/wikidata";

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX schema: <http://schema.org/>
`;

export type WikidataItem = {
  qid: string;
  category: Category;
  title: string;
  titleNl: string | null;
  startYear: number;
  /** null = ongoing. Equal to startYear for point-in-time items. */
  endYear: number | null;
  sitelinks: number;
  wikipediaUrl: string | null;
  wikipediaUrlNl: string | null;
};

type Spec = {
  /** Direct P31 classes for tile queries (fast and low-noise, unlike subclass paths). */
  classes: string[];
  startProps: string[];
  endProps: string[];
  extraFilter?: string;
  /** Notability floor (sitelinks) for this category; default MIN_SITELINKS. */
  minSitelinks?: number;
};

export const SPECS: Record<Category, Spec> = {
  person: { classes: ["Q5"], startProps: ["P569"], endProps: ["P570"] },
  war: {
    // war, civil war, world war, armed conflict, invasion, rebellion, insurgency
    classes: ["Q198", "Q8465", "Q103495", "Q350604", "Q467011", "Q124734", "Q1323212"],
    startProps: ["P580"],
    endProps: ["P582"],
  },
  event: {
    // battle, revolution, treaty, terrorist attack, disaster, event, assassination, epidemic,
    // protest, natural disaster, referendum, expedition, coup d'état, massacre, pandemic
    classes: [
      "Q178561", "Q10931", "Q131569", "Q2223653", "Q3839081", "Q1656682", "Q3882219",
      "Q44512", "Q175331", "Q8065", "Q43109", "Q2401485", "Q45382", "Q3199915", "Q12184",
    ],
    startProps: ["P585", "P580"],
    endProps: ["P582"],
  },
  period: {
    // historical period, era, historical country, empire, dynasty
    classes: ["Q11514315", "Q6428674", "Q3024240", "Q48349", "Q164950"],
    startProps: ["P580", "P571"],
    // Lots of obscure statelets and "periods" otherwise.
    minSitelinks: 25,
    endProps: ["P582", "P576"],
  },
  invention: {
    classes: [],
    startProps: ["P575"],
    endProps: [],
    // Drop astronomical objects (P59/P397), taxa (P105), places (P625), elements (P246),
    // diseases (P494 ICD-10, P699 Disease Ontology),
    // chemical substances (P274) and people.
    extraFilter: `FILTER NOT EXISTS { ?item wdt:P59 ?x1 }
    FILTER NOT EXISTS { ?item wdt:P105 ?x2 }
    FILTER NOT EXISTS { ?item wdt:P625 ?x3 }
    FILTER NOT EXISTS { ?item wdt:P397 ?x4 }
    FILTER NOT EXISTS { ?item wdt:P274 ?x5 }
    FILTER NOT EXISTS { ?item wdt:P246 ?x6 }
    FILTER NOT EXISTS { ?item wdt:P494 ?x7 }
    FILTER NOT EXISTS { ?item wdt:P699 ?x8 }
    FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }`,
  },
  artwork: {
    // painting, sculpture, literary work, musical work, opera, musical composition, novel, poem
    classes: ["Q3305213", "Q860861", "Q7725634", "Q105543609", "Q1344", "Q207628", "Q8261", "Q5185279"],
    startProps: ["P571", "P577"],
    endProps: [],
  },
  place: {
    // building, tower, skyscraper, bridge, church, cathedral, castle, palace, temple, mosque,
    // monument, canal, dam, stadium, museum, archaeological site, lattice tower, fort, memorial
    classes: [
      "Q41176", "Q12518", "Q11303", "Q12280", "Q16970", "Q2977", "Q23413", "Q16560", "Q44539",
      "Q32815", "Q4989906", "Q12284", "Q12323", "Q483110", "Q33506", "Q839954", "Q1440476",
      "Q1785071", "Q5003624",
    ],
    startProps: ["P571"],
    endProps: ["P576"],
  },
};

/** Root classes (matched via P31/P279*) used to classify arbitrary items, e.g. search hits. */
const ROOTS: Array<{ category: Category; qids: string[] }> = [
  { category: "person", qids: ["Q5"] },
  { category: "war", qids: ["Q198", "Q350604"] },
  { category: "period", qids: ["Q11514315", "Q3024240", "Q6428674", "Q164950", "Q968159"] },
  { category: "artwork", qids: ["Q838948", "Q7725634", "Q2188189", "Q105543609"] },
  { category: "place", qids: ["Q41176", "Q811979", "Q839954"] },
  { category: "invention", qids: ["Q39546", "Q11019", "Q1183543"] },
  { category: "event", qids: ["Q1190554", "Q1656682"] },
];

function yearLiteral(year: number): string {
  const y = Math.trunc(year);
  const abs = String(Math.abs(y)).padStart(4, "0");
  return `"${y < 0 ? "-" : ""}${abs}-01-01T00:00:00Z"^^xsd:dateTime`;
}

function parseYear(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+)-/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

function qidOf(iri: string): string {
  return iri.slice(iri.lastIndexOf("/") + 1);
}

const altPath = (props: string[]) => props.map((p) => `wdt:${p}`).join("|");

type Binding = Record<string, { value: string } | undefined>;

async function runSparql(query: string): Promise<Binding[]> {
  const res = await politeFetch(throttles.sparql, SPARQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ query: PREFIXES + query }),
    timeoutMs: 60_000,
    // QLever sometimes sends a short Retry-After; otherwise wait a minute. After that the caller
    // marks the tile failed and retries it later.
    retries: 2,
    backoffMs: 60_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SPARQL ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results: { bindings: Binding[] } };
  return json.results.bindings;
}

const NOW_YEAR = new Date().getFullYear();
/** Notability floor for tiles: articles in at least this many Wikimedia projects. */
const MIN_SITELINKS = 10;

/** Decide the end year, guarding against missing data (e.g. a 17th-century person with no death date). */
function resolveEnd(category: Category, start: number, end: number | null): number | null {
  if (end !== null && end >= start) return end;
  switch (category) {
    case "person":
      return start > NOW_YEAR - 105 ? null : start;
    case "war":
      return start > NOW_YEAR - 25 ? null : start;
    case "period":
      return start > NOW_YEAR - 80 ? null : start;
    default:
      return start;
  }
}

function toItem(
  qid: string,
  category: Category,
  b: { label?: string; labelNl?: string; start: number | null; end: number | null; sl?: string; en?: string; nl?: string },
): WikidataItem | null {
  const title = b.label || b.labelNl;
  if (!title || b.start === null) return null;
  if (b.start > NOW_YEAR) return null;
  return {
    qid,
    category,
    title,
    titleNl: b.labelNl || null,
    startYear: b.start,
    endYear: resolveEnd(category, b.start, b.end),
    sitelinks: Number(b.sl ?? 0) || 0,
    wikipediaUrl: b.en ?? null,
    wikipediaUrlNl: b.nl ?? null,
  };
}

const LABEL_AND_LINKS = `
  OPTIONAL { ?item rdfs:label ?label0 FILTER(LANG(?label0) = "en") }
  OPTIONAL { ?item rdfs:label ?labelNl0 FILTER(LANG(?labelNl0) = "nl") }
  OPTIONAL { ?en0 schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?nl0 schema:about ?item ; schema:isPartOf <https://nl.wikipedia.org/> }`;

const LABEL_AND_LINKS_AGG = `(SAMPLE(?label0) AS ?label) (SAMPLE(?labelNl0) AS ?labelNl) (SAMPLE(?en0) AS ?en) (SAMPLE(?nl0) AS ?nl)`;

/**
 * The `limit` most notable items (by Wikipedia sitelink count) per category whose
 * start year falls in [fromYear, toYear). All categories go into ONE query (a UNION of
 * per-category top-N subqueries) to keep the request count low.
 */
export async function fetchTile(
  categories: readonly Category[],
  fromYear: number,
  toYear: number,
  limit = 15,
): Promise<WikidataItem[]> {
  if (categories.length === 0) return [];
  const branch = (category: Category) => {
    const spec = SPECS[category];
    const classClause = spec.classes.length
      ? `VALUES ?cls { ${spec.classes.map((c) => `wd:${c}`).join(" ")} }\n        ?item wdt:P31 ?cls .`
      : "";
    const startClause =
      spec.startProps.length === 1
        ? `?item wdt:${spec.startProps[0]} ?s0 .`
        : spec.startProps.map((p) => `{ ?item wdt:${p} ?s0 }`).join(" UNION ");
    const endClause = spec.endProps.length ? `OPTIONAL { ?item ${altPath(spec.endProps)} ?end0 }` : "";
    return `{
    {
      SELECT ?item (MAX(?sl0) AS ?sl) (MIN(?s0) AS ?start) WHERE {
        ${classClause}
        ?item wikibase:sitelinks ?sl0 .
        FILTER(?sl0 >= ${spec.minSitelinks ?? MIN_SITELINKS})
        ${startClause}
        FILTER(?s0 >= ${yearLiteral(fromYear)} && ?s0 < ${yearLiteral(toYear)})
        ${spec.extraFilter ?? ""}
      }
      GROUP BY ?item
      ORDER BY DESC(?sl)
      LIMIT ${limit}
    }
    ${endClause}
    BIND("${category}" AS ?cat)
  }`;
  };

  const query = `
SELECT ?item ?cat ?sl ?start (MIN(?end0) AS ?end) ${LABEL_AND_LINKS_AGG} WHERE {
  ${categories.map(branch).join("\n  UNION\n  ")}
  ${LABEL_AND_LINKS}
}
GROUP BY ?item ?cat ?sl ?start`;

  const rows = await runSparql(query);
  return rows
    .map((r) =>
      toItem(qidOf(r.item!.value), r.cat!.value as Category, {
        label: r.label?.value,
        labelNl: r.labelNl?.value,
        start: parseYear(r.start?.value),
        end: parseYear(r.end?.value),
        sl: r.sl?.value,
        en: r.en?.value,
        nl: r.nl?.value,
      }),
    )
    .filter((x): x is WikidataItem => x !== null);
}

const DATE_PROPS = {
  birth: "P569",
  death: "P570",
  start: "P580",
  end: "P582",
  point: "P585",
  inception: "P571",
  dissolved: "P576",
  published: "P577",
  discovered: "P575",
} as const;


// ---------- Arbitrary items via the Wikidata Action API (used for search hits) ----------

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

type Snak = { mainsnak?: { datavalue?: { value?: unknown } }; rank?: "preferred" | "normal" | "deprecated" };
type Entity = {
  id: string;
  missing?: string;
  labels?: Record<string, { value: string }>;
  claims?: Record<string, Snak[]>;
  sitelinks?: Record<string, { url?: string }>;
};

/** Values of the best-ranked statements, like the "truthy" wdt: values in SPARQL. */
function bestValues(entity: Entity, prop: string): unknown[] {
  const claims = (entity.claims?.[prop] ?? []).filter((c) => c.rank !== "deprecated");
  const preferred = claims.filter((c) => c.rank === "preferred");
  return (preferred.length ? preferred : claims)
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => v !== undefined);
}

function itemIds(entity: Entity, prop: string): string[] {
  return bestValues(entity, prop)
    .map((v) => (v as { id?: string }).id)
    .filter((x): x is string => !!x);
}

function minYear(entity: Entity, prop: string): number | null {
  const years = bestValues(entity, prop)
    .map((v) => parseYear((v as { time?: string }).time?.replace(/^\+/, "")))
    .filter((y): y is number => y !== null);
  return years.length ? Math.min(...years) : null;
}

async function wbgetentities(ids: string[], props: string): Promise<Entity[]> {
  const out: Entity[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: ids.slice(i, i + 50).join("|"),
      props,
      languages: "en|nl",
      format: "json",
    });
    const res = await politeFetch(throttles.wikidata, `${WIKIDATA_API}?${params}`, {
      headers: { Accept: "application/json" },
      maxWaitMs: 3000,
      retries: 1,
    });
    if (!res.ok) throw new Error(`wbgetentities ${res.status}`);
    const data = (await res.json()) as { entities?: Record<string, Entity> };
    out.push(...Object.values(data.entities ?? {}).filter((e) => !e.missing));
  }
  return out;
}

/** Persistent cache: per Wikidata class, which of our ROOTS classes it falls under. */
export type ClassCache = {
  get(qid: string): string[] | undefined;
  set(qid: string, roots: string[]): void;
};

const WDQS_URL = "https://query.wikidata.org/sparql";
const ALL_ROOTS = ROOTS.flatMap((r) => r.qids);

/**
 * For each class, the ROOTS classes it is a (transitive) subclass of. One small query on the
 * official Wikidata Query Service, which is fast for fixed starting classes; results cached.
 */
async function classRoots(classes: string[], cache: ClassCache): Promise<Map<string, string[]>> {
  const unique = [...new Set(classes)];
  const unknown = unique.filter((c) => cache.get(c) === undefined).slice(0, 200);
  if (unknown.length) {
    const query = `SELECT ?c ?root WHERE {
  VALUES ?c { ${unknown.map((c) => `wd:${c}`).join(" ")} }
  VALUES ?root { ${ALL_ROOTS.map((c) => `wd:${c}`).join(" ")} }
  ?c wdt:P279* ?root
}`;
    const res = await politeFetch(throttles.wdqs, WDQS_URL, {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: PREFIXES + query }),
      timeoutMs: 30_000,
      maxWaitMs: 3000,
      retries: 1,
    });
    if (!res.ok) throw new Error(`WDQS ${res.status}`);
    const json = (await res.json()) as { results: { bindings: Binding[] } };
    const found = new Map<string, Set<string>>(unknown.map((c) => [c, new Set<string>()]));
    for (const b of json.results.bindings) found.get(qidOf(b.c!.value))?.add(qidOf(b.root!.value));
    for (const [c, roots] of found) cache.set(c, [...roots]);
  }
  return new Map(unique.map((c) => [c, cache.get(c) ?? []]));
}

/**
 * Look up arbitrary items (e.g. search hits) and classify them into our categories via
 * their classes (P31) and superclasses (P279). One Wikidata API request for the items plus,
 * for classes not seen before, one small Wikidata Query Service query.
 */
export async function fetchByQids(qids: string[], cache: ClassCache): Promise<WikidataItem[]> {
  const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))].slice(0, 50);
  if (ids.length === 0) return [];
  const entities = await wbgetentities(ids, "labels|claims|sitelinks/urls");
  const rootsOf = await classRoots(entities.flatMap((e) => itemIds(e, "P31")), cache);

  const out: WikidataItem[] = [];
  for (const e of entities) {
    const all = new Set(itemIds(e, "P31").flatMap((c) => rootsOf.get(c) ?? []));
    const y = (k: keyof typeof DATE_PROPS) => minYear(e, DATE_PROPS[k]);

    let category: Category | null = ROOTS.find((r) => r.qids.some((q) => all.has(q)))?.category ?? null;
    if (!category && y("discovered") !== null) category = "invention";
    if (!category && y("birth") !== null) category = "person";
    if (!category) continue;

    let start: number | null;
    let end: number | null;
    switch (category) {
      case "person":
        start = y("birth");
        end = y("death");
        break;
      case "invention":
        start = y("discovered") ?? y("inception") ?? y("published");
        end = null;
        break;
      case "artwork":
        start = y("inception") ?? y("published");
        end = null;
        break;
      case "place":
        start = y("inception") ?? y("start");
        end = y("dissolved");
        break;
      default:
        start = y("point") ?? y("start") ?? y("inception");
        end = y("end") ?? y("dissolved");
    }

    const item = toItem(e.id, category, {
      label: e.labels?.en?.value,
      labelNl: e.labels?.nl?.value,
      start,
      end,
      sl: String(Object.keys(e.sitelinks ?? {}).length),
      en: e.sitelinks?.enwiki?.url,
      nl: e.sitelinks?.nlwiki?.url,
    });
    if (item) out.push(item);
  }
  // Keep the caller's (relevance) order.
  return out.sort((a, b) => ids.indexOf(a.qid) - ids.indexOf(b.qid));
}
