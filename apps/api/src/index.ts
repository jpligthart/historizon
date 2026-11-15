import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CATEGORIES,
  DEFAULT_ZOOM_YEARS,
  ZOOM_PRESETS_YEARS,
  type Category,
  type HealthResponse,
} from "@historizon/shared";
import {
  getItem,
  getItemsByWikidataIds,
  getMeta,
  openDb,
  queryItems,
  rowToItem,
  updateDescription,
  upsertItem,
} from "./db.js";
import { Discovery } from "./discovery.js";
import { SEED_ITEMS } from "./seed-data.js";
import { fetchWikipediaExtract } from "./wikipedia.js";

const app = new Hono();
const database = openDb();
const discovery = new Discovery(database);

function parseCategories(param: string | undefined): Category[] | undefined {
  if (!param) return undefined;
  return param
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is Category => (CATEGORIES as readonly string[]).includes(x));
}

const count = getMeta(database).count;
if (count === 0) {
  database.exec("BEGIN");
  try {
    for (const item of SEED_ITEMS) {
      upsertItem(database, {
        id: item.id,
        title: item.title,
        titleNl: item.titleNl ?? null,
        category: item.category,
        startYear: item.startYear,
        endYear: item.endYear === undefined ? item.startYear : item.endYear,
        description: item.description ?? null,
        descriptionNl: null,
        wikipediaUrl: item.wikipediaUrl ?? null,
        wikipediaUrlNl: null,
        wikidataId: item.wikidataId ?? null,
      });
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  console.log(`Auto-seeded ${SEED_ITEMS.length} items`);
}

// Background data upkeep: give curated items their Wikidata ids (one request) and merge
// duplicates, then one-off category migrations (each runs once, recorded in app_meta).
void discovery
  .linkCuratedItems()
  .then(() => discovery.splitStatesFromPeriods())
  .then(() => discovery.cleanupStatesAndPeriods())
  .catch((err) => console.warn("[startup] data migration failed:", (err as Error).message));

app.use(
  "*",
  cors({
    origin: "*",
  }),
);

app.get("/health", (c) => {
  const body: HealthResponse = { status: "ok", service: "historizon-api" };
  return c.json(body);
});

app.get("/api/meta", (c) => {
  const meta = getMeta(database);
  return c.json({
    ...meta,
    categories: [...CATEGORIES],
    zoomPresets: ZOOM_PRESETS_YEARS,
    defaultZoomYears: DEFAULT_ZOOM_YEARS,
  });
});

app.get("/api/items", (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return c.json({ error: "Invalid from/to year range" }, 400);
  }

  const categories = parseCategories(c.req.query("categories"));
  const q = c.req.query("q") ?? undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const perCategory = c.req.query("perCategory") ? Number(c.req.query("perCategory")) : undefined;

  // fetch=1: also discover more items for this viewport in the background.
  const pending = c.req.query("fetch") === "1" ? discovery.ensure(from, to, categories) : 0;
  const items = queryItems(database, { from, to, categories, q, limit, perCategory });
  return c.json({ items, from, to, count: items.length, pending });
});

app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const lang = c.req.query("lang") === "nl" ? "nl" : "en";
  if (q.length < 2) return c.json({ items: [], remote: "skipped" });

  // Wikipedia hits first (relevance order), then local full-text matches.
  const { qids, remote } = await discovery.search(q, lang);
  const fromWiki = getItemsByWikidataIds(database, qids);
  const seen = new Set(fromWiki.map((i) => i.id));
  const local = queryItems(database, { from: -100000, to: 100000, q, limit: 50 }).filter((i) => !seen.has(i.id));
  return c.json({ items: [...fromWiki, ...local], remote });
});

app.get("/api/items/:id", async (c) => {
  const id = c.req.param("id");
  const row = getItem(database, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  let item = rowToItem(row);
  const enrich = c.req.query("enrich") !== "0";
  const lang = c.req.query("lang") === "nl" ? "nl" : "en";

  try {
    // Dutch extract when viewing in Dutch and a Dutch article exists; otherwise English.
    if (enrich && lang === "nl" && !item.descriptionNl && item.wikipediaUrlNl) {
      const extracted = await fetchWikipediaExtract(item.wikipediaUrlNl, "nl");
      if (extracted) updateDescription(database, id, extracted.extract, extracted.url, "nl");
    } else if (enrich && !item.description && item.wikipediaUrl && !(lang === "nl" && item.descriptionNl)) {
      const extracted = await fetchWikipediaExtract(item.wikipediaUrl, "en");
      if (extracted) updateDescription(database, id, extracted.extract, extracted.url, "en");
    }
  } catch (err) {
    console.warn(`[extract] ${id}:`, (err as Error).message);
  }
  const refreshed = getItem(database, id);
  if (refreshed) item = rowToItem(refreshed);

  return c.json({ item });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Historizon API listening on ${port}`);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
