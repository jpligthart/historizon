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
  getMeta,
  openDb,
  queryItems,
  rowToItem,
  updateDescription,
  upsertItem,
} from "./db.js";
import { SEED_ITEMS } from "./seed-data.js";
import { fetchWikipediaExtract } from "./wikipedia.js";

const app = new Hono();
const database = openDb();

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

  const categoriesParam = c.req.query("categories");
  const categories = categoriesParam
    ? (categoriesParam
        .split(",")
        .map((x) => x.trim())
        .filter((x): x is Category => (CATEGORIES as readonly string[]).includes(x)) as Category[])
    : undefined;

  const q = c.req.query("q") ?? undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

  const items = queryItems(database, { from, to, categories, q, limit });
  return c.json({ items, from, to, count: items.length });
});

app.get("/api/items/:id", async (c) => {
  const id = c.req.param("id");
  const row = getItem(database, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  let item = rowToItem(row);
  const enrich = c.req.query("enrich") !== "0";

  if (enrich && !item.description && item.wikipediaUrl) {
    const extracted = await fetchWikipediaExtract(item.wikipediaUrl, "en");
    if (extracted) {
      updateDescription(database, id, extracted.extract, extracted.url);
      const refreshed = getItem(database, id);
      if (refreshed) item = rowToItem(refreshed);
    }
  }

  return c.json({ item });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Historizon API listening on ${port}`);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
