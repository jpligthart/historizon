import type { Category, Domain } from "@historizon/shared";
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
  /** Known to have a Dutch connection (set for items from a Dutch tile). */
  nlLink?: boolean;
};

// ---------- Dutch connection (Nederland-bril) ----------

/**
 * The Netherlands and its historical predecessors, so the Golden Age counts too:
 * Netherlands, Kingdom of the Netherlands, Dutch Republic, Batavian Republic, Kingdom of
 * Holland, Habsburg Netherlands, Seventeen Provinces, Burgundian Netherlands, United
 * Kingdom of the Netherlands.
 */
const NL_POLITIES = ["Q55", "Q29999", "Q170072", "Q188553", "Q212278", "Q1031430", "Q330533", "Q157109", "Q15864"];

/** Dutch tiles reach further down: Dutch topics have far fewer language editions. */
const NL_MIN_SITELINKS = 5;

const NL_VALUES = NL_POLITIES.map((q) => `wd:${q}`).join(" ");

/**
 * SPARQL pattern binding ?item only if it has a Dutch connection: Dutch nationality, Dutch
 * origin, the Netherlands took part (wars), made by a Dutch maker, itself a Dutch polity,
 * or located ONLY in the Netherlands (a pandemic or protest wave that also reached the
 * Netherlands doesn't count). `withBirthplace` adds "born in the Netherlands": accurate but
 * heavy, so only used when checking known items, not when scanning tiles.
 */
function nlPattern(withBirthplace: boolean): string {
  return `
        VALUES ?nlc { ${NL_VALUES} }
        { ?item wdt:P27|wdt:P495|wdt:P710 ?nlc }
        UNION { ?item wdt:P17 ?nlc .
                FILTER NOT EXISTS { ?item wdt:P17 ?otherCountry . FILTER(?otherCountry NOT IN (${NL_POLITIES.map((q) => `wd:${q}`).join(", ")})) } }
        UNION { ?item wdt:P170/wdt:P27 ?nlc }
        ${withBirthplace ? "UNION { ?item wdt:P19/wdt:P17 ?nlc }" : ""}
        UNION { VALUES ?item { ${NL_VALUES} } }`;
}

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
  state: {
    // historical country, empire, dynasty. Present-day states (Saudi Arabia, Singapore…) are
    // left out on purpose: as bars running to today they would fill every view.
    classes: ["Q3024240", "Q48349", "Q164950"],
    startProps: ["P571", "P580"],
    endProps: ["P576", "P582"],
    // Lots of obscure statelets otherwise.
    minSitelinks: 25,
  },
  period: {
    // historical period, era, art movement (Renaissance, Baroque, Romanticism…)
    classes: ["Q11514315", "Q6428674", "Q968159"],
    startProps: ["P580", "P571"],
    endProps: ["P582", "P576"],
    // Keeps out niche "periods" and micro-movements.
    minSitelinks: 25,
    // Music genres (rap, jazz) are tagged as art movements too.
    extraFilter: `FILTER NOT EXISTS { ?item wdt:P31 wd:Q188451 }`,
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
  { category: "state", qids: ["Q3024240", "Q48349", "Q164950"] },
  { category: "period", qids: ["Q11514315", "Q6428674", "Q968159"] },
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
    case "state":
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
  /** Only items with a Dutch connection, with a lower notability floor. */
  opts: { nlOnly?: boolean } = {},
): Promise<WikidataItem[]> {
  if (categories.length === 0) return [];
  const nlOnly = !!opts.nlOnly;
  const branch = (category: Category) => {
    const spec = SPECS[category];
    const minSitelinks = nlOnly ? NL_MIN_SITELINKS : (spec.minSitelinks ?? MIN_SITELINKS);
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
        FILTER(?sl0 >= ${minSitelinks})
        ${startClause}
        FILTER(?s0 >= ${yearLiteral(fromYear)} && ?s0 < ${yearLiteral(toYear)})
        ${spec.extraFilter ?? ""}
        ${nlOnly ? nlPattern(false) : ""}
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
    .filter((x): x is WikidataItem => x !== null)
    .map((x) => (nlOnly ? { ...x, nlLink: true } : x));
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

/** Wikipedia article URL for a Wikidata item in the given language, if a sitelink exists. */
export async function wikipediaSitelink(qid: string, lang: "en" | "nl"): Promise<string | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const entities = await wbgetentities([qid], "sitelinks/urls");
  const key = lang === "nl" ? "nlwiki" : "enwiki";
  return entities[0]?.sitelinks?.[key]?.url ?? null;
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
function classRoots(classes: string[], cache: ClassCache): Promise<Map<string, string[]>> {
  return subclassRoots(classes, ALL_ROOTS, cache);
}

/** For each class, which of `roots` it is (transitively, via P279) a subclass of. Cached. */
async function subclassRoots(classes: string[], roots: string[], cache: ClassCache): Promise<Map<string, string[]>> {
  const unique = [...new Set(classes)];
  const unknown = unique.filter((c) => cache.get(c) === undefined).slice(0, 200);
  if (unknown.length) {
    const query = `SELECT ?c ?root WHERE {
  VALUES ?c { ${unknown.map((c) => `wd:${c}`).join(" ")} }
  VALUES ?root { ${roots.map((c) => `wd:${c}`).join(" ")} }
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

/**
 * Which of the given items are (instances of subclasses of) the given category's root
 * classes. Small queries on the official Wikidata Query Service; used for re-classifying
 * stored items when categories change.
 */
export async function qidsInCategoryRoots(qids: string[], category: Category): Promise<string[]> {
  return qidsUnderClasses(qids, ROOTS.find((r) => r.category === category)?.qids ?? []);
}

/** Which of the given items are instances of (subclasses of) any of the given classes. */
export async function qidsUnderClasses(qids: string[], roots: string[]): Promise<string[]> {
  if (roots.length === 0 || qids.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < qids.length; i += 100) {
    const batch = qids.slice(i, i + 100);
    const query = `SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${batch.map((q) => `wd:${q}`).join(" ")} }
  VALUES ?root { ${roots.map((q) => `wd:${q}`).join(" ")} }
  ?item wdt:P31/wdt:P279* ?root
}`;
    const res = await politeFetch(throttles.wdqs, WDQS_URL, {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: PREFIXES + query }),
      timeoutMs: 30_000,
    });
    if (!res.ok) throw new Error(`WDQS ${res.status}`);
    const json = (await res.json()) as { results: { bindings: Binding[] } };
    out.push(...json.results.bindings.map((b) => qidOf(b.item!.value)));
  }
  return out;
}

/**
 * Which of the given items have a Dutch connection. Small queries (bound items) on the
 * official Wikidata Query Service; used to flag items that came in via global tiles,
 * search or the seed.
 */
export async function qidsWithNlLink(qids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < qids.length; i += 100) {
    const batch = qids.slice(i, i + 100);
    const query = `SELECT DISTINCT ?item WHERE {
        VALUES ?item { ${batch.map((q) => `wd:${q}`).join(" ")} }
        ${nlPattern(true)}
}`;
    const res = await politeFetch(throttles.wdqs, WDQS_URL, {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: PREFIXES + query }),
      timeoutMs: 30_000,
    });
    if (!res.ok) throw new Error(`WDQS ${res.status}`);
    const json = (await res.json()) as { results: { bindings: Binding[] } };
    for (const b of json.results.bindings) out.add(qidOf(b.item!.value));
  }
  return out;
}

// ---------- What a person is known for (domain) ----------

/** Root occupations per domain; an occupation counts when it is a (P279*) subclass of one. */
const OCCUPATION_ROOTS: Record<Exclude<Domain, "other">, string[]> = {
  // politician, monarch, military personnel, diplomat, revolutionary, statesperson
  politics: ["Q82955", "Q116", "Q47064", "Q193391", "Q3242115", "Q372436"],
  // scientist, mathematician, engineer, inventor, physician, explorer
  science: ["Q901", "Q170790", "Q81096", "Q205375", "Q39631", "Q11900058"],
  // philosopher, theologian, cleric, priest
  thought: ["Q4964182", "Q1234713", "Q250867", "Q42603"],
  // writer, poet
  literature: ["Q36180", "Q49757"],
  // painter, sculptor, architect, visual artist, photographer
  arts: ["Q1028181", "Q1281618", "Q42973", "Q3391743", "Q33231"],
  // musician, composer, singer
  music: ["Q639669", "Q36834", "Q177220"],
  // actor, film director
  film: ["Q33999", "Q2526255"],
  // athlete
  sport: ["Q2066131"],
  // businessperson, entrepreneur
  business: ["Q43845", "Q131524"],
};

/**
 * When one occupation falls under several domains (a screenwriter is a writer and film
 * maker; a singer is an artist), the more specific domain wins: earlier in this list.
 */
const DOMAIN_PRECEDENCE: Array<Exclude<Domain, "other">> = [
  "sport", "music", "film", "literature", "thought", "science", "politics", "business", "arts",
];

const ROOT_DOMAIN = new Map<string, Exclude<Domain, "other">>(
  Object.entries(OCCUPATION_ROOTS).flatMap(([d, qs]) => qs.map((q) => [q, d as Exclude<Domain, "other">])),
);
const ALL_OCCUPATION_ROOTS = [...ROOT_DOMAIN.keys()];

/** A person's occupations (P106) in the order editors listed them, best rank only. */
async function occupationsOf(qid: string): Promise<string[]> {
  const params = new URLSearchParams({ action: "wbgetclaims", entity: qid, property: "P106", format: "json" });
  const res = await politeFetch(throttles.wikidataBackground, `${WIKIDATA_API}?${params}`, {
    headers: { Accept: "application/json" },
    retries: 4,
    backoffMs: 5000,
  });
  if (!res.ok) throw new Error(`wbgetclaims ${res.status}`);
  const data = (await res.json()) as { claims?: Record<string, Snak[]> };
  return itemIds({ id: qid, claims: data.claims }, "P106");
}

/** Which of the given persons held a position (P39) or a noble title (P97). */
async function qidsWithOfficeOrTitle(qids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (qids.length === 0) return out;
  const query = `SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  { ?item wdt:P39 ?x } UNION { ?item wdt:P97 ?y }
}`;
  const res = await politeFetch(throttles.wdqs, WDQS_URL, {
    method: "POST",
    headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query: PREFIXES + query }),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`WDQS ${res.status}`);
  const json = (await res.json()) as { results: { bindings: Binding[] } };
  for (const b of json.results.bindings) out.add(qidOf(b.item!.value));
  return out;
}

/**
 * What each person is mainly known for: the domain of their FIRST listed occupation (P106)
 * that fits one, as Wikidata editors tend to list the main occupation first. Without one,
 * a political office (P39) or noble title (P97) means politics; otherwise "other".
 * Meant for background use: waits out rate limits. `cache` is shared with the class cache,
 * so keys are prefixed.
 */
export async function fetchPersonDomains(qids: string[], cache: ClassCache): Promise<Map<string, Domain>> {
  const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
  const out = new Map<string, Domain>();
  if (ids.length === 0) return out;
  const occupations = new Map<string, string[]>();
  for (const q of ids) occupations.set(q, await occupationsOf(q));
  const occCache: ClassCache = {
    get: (q) => cache.get(`occ:${q}`),
    set: (q, roots) => cache.set(`occ:${q}`, roots),
  };
  const rootsOf = await subclassRoots([...occupations.values()].flat(), ALL_OCCUPATION_ROOTS, occCache);
  for (const [q, occs] of occupations) {
    for (const occ of occs) {
      const domains = new Set((rootsOf.get(occ) ?? []).map((r) => ROOT_DOMAIN.get(r)));
      const domain = DOMAIN_PRECEDENCE.find((d) => domains.has(d));
      if (domain) {
        out.set(q, domain);
        break;
      }
    }
  }
  const political = await qidsWithOfficeOrTitle(ids.filter((q) => !out.has(q)));
  for (const q of ids) if (!out.has(q)) out.set(q, political.has(q) ? "politics" : "other");
  return out;
}
