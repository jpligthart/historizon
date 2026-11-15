import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Category, TimelineItem } from "@historizon/shared";
import { CATEGORIES, NL_BOOST } from "@historizon/shared";
import type { ClassCache, WikidataItem } from "./wikidata.js";

export type ItemRow = {
  id: string;
  title: string;
  title_nl: string | null;
  category: Category;
  start_year: number;
  end_year: number | null;
  description: string | null;
  description_nl: string | null;
  wikipedia_url: string | null;
  wikipedia_url_nl: string | null;
  wikidata_id: string | null;
  extract_cached_at: string | null;
  importance: number | null;
  nl_link: number | null;
};

let db: DatabaseSync | null = null;

export function getDbPath(): string {
  return resolve(process.env.SQLITE_PATH ?? "./data/historizon.sqlite");
}

export function openDb(): DatabaseSync {
  if (db) return db;
  const path = getDbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

const ITEM_COLUMNS = [
  "id", "title", "title_nl", "category", "start_year", "end_year", "description", "description_nl",
  "wikipedia_url", "wikipedia_url_nl", "wikidata_id", "extract_cached_at", "importance", "nl_link",
];

function itemsTableSql(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_nl TEXT,
      category TEXT NOT NULL CHECK (category IN (${CATEGORIES.map((c) => `'${c}'`).join(",")})),
      start_year INTEGER NOT NULL,
      end_year INTEGER,
      description TEXT,
      description_nl TEXT,
      wikipedia_url TEXT,
      wikipedia_url_nl TEXT,
      wikidata_id TEXT,
      extract_cached_at TEXT,
      importance INTEGER,
      nl_link INTEGER
    );`;
}

/**
 * SQLite can't change a CHECK constraint in place. When CATEGORIES gains a value, rebuild
 * the items table (copying all rows) so the new category is accepted.
 */
function rebuildItemsIfCategoriesChanged(database: DatabaseSync): void {
  const row = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'`).get() as
    | { sql: string }
    | undefined;
  if (!row || CATEGORIES.every((c) => row.sql.includes(`'${c}'`))) return;

  const existing = new Set(
    (database.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const cols = ITEM_COLUMNS.filter((c) => existing.has(c)).join(", ");
  database.exec("BEGIN");
  try {
    database.exec(`ALTER TABLE items RENAME TO items_old`);
    database.exec(itemsTableSql("items"));
    database.exec(`INSERT INTO items (${cols}) SELECT ${cols} FROM items_old`);
    database.exec(`DROP TABLE items_old`);
    database.exec("COMMIT");
    console.log(`[db] items table rebuilt for categories: ${CATEGORIES.join(", ")}`);
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

function migrate(database: DatabaseSync): void {
  rebuildItemsIfCategoriesChanged(database);
  database.exec(`
    ${itemsTableSql("items")}

    CREATE INDEX IF NOT EXISTS idx_items_years ON items(start_year, end_year);
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_wikidata ON items(wikidata_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      id UNINDEXED,
      title,
      title_nl,
      description,
      description_nl,
      tokenize = 'porter unicode61'
    );

    -- Which (category set, level, period) tiles have been fetched from Wikidata.
    CREATE TABLE IF NOT EXISTS tiles (
      key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0
    );

    DROP TABLE IF EXISTS class_cache; -- superseded by class_roots

    -- Per Wikidata class: which category root classes it falls under (via P279*).
    CREATE TABLE IF NOT EXISTS class_roots (
      qid TEXT PRIMARY KEY,
      roots TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- One-off data migrations that have run (key = migration name).
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Wikipedia search results (as Wikidata ids, in relevance order) per language + query.
    CREATE TABLE IF NOT EXISTS search_cache (
      key TEXT PRIMARY KEY,
      qids TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  const columns = new Set(
    (database.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("nl_link")) {
    // Dutch connection for the "Nederland-bril" (1/0; NULL = not checked yet).
    database.exec(`ALTER TABLE items ADD COLUMN nl_link INTEGER`);
  }
  if (!columns.has("importance")) {
    // Notability: number of Wikipedia language editions (Wikidata sitelinks).
    database.exec(`ALTER TABLE items ADD COLUMN importance INTEGER`);
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_items_wiki_url ON items(wikipedia_url)`);
}

export function rowToItem(row: ItemRow): TimelineItem {
  return {
    id: row.id,
    title: row.title,
    titleNl: row.title_nl,
    category: row.category,
    startYear: row.start_year,
    endYear: row.end_year,
    description: row.description,
    descriptionNl: row.description_nl,
    wikipediaUrl: row.wikipedia_url,
    wikipediaUrlNl: row.wikipedia_url_nl,
    wikidataId: row.wikidata_id,
    descriptionFromWikipedia: row.extract_cached_at !== null,
    importance: row.importance,
    nlLink: row.nl_link === null ? null : row.nl_link === 1,
  };
}

export function upsertItem(
  database: DatabaseSync,
  item: Omit<TimelineItem, "description" | "descriptionNl" | "descriptionFromWikipedia" | "importance" | "nlLink"> & {
    description?: string | null;
    descriptionNl?: string | null;
  },
): void {
  database
    .prepare(
      `
    INSERT INTO items (
      id, title, title_nl, category, start_year, end_year,
      description, description_nl, wikipedia_url, wikipedia_url_nl, wikidata_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      title_nl = COALESCE(excluded.title_nl, items.title_nl),
      category = excluded.category,
      start_year = excluded.start_year,
      end_year = excluded.end_year,
      description = COALESCE(excluded.description, items.description),
      description_nl = COALESCE(excluded.description_nl, items.description_nl),
      wikipedia_url = COALESCE(excluded.wikipedia_url, items.wikipedia_url),
      wikipedia_url_nl = COALESCE(excluded.wikipedia_url_nl, items.wikipedia_url_nl),
      wikidata_id = COALESCE(excluded.wikidata_id, items.wikidata_id)
  `,
    )
    .run(
      item.id,
      item.title,
      item.titleNl,
      item.category,
      item.startYear,
      item.endYear,
      item.description ?? null,
      item.descriptionNl ?? null,
      item.wikipediaUrl,
      item.wikipediaUrlNl,
      item.wikidataId,
    );

  database.prepare(`DELETE FROM items_fts WHERE id = ?`).run(item.id);
  database
    .prepare(
      `INSERT INTO items_fts (id, title, title_nl, description, description_nl)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.title,
      item.titleNl ?? "",
      item.description ?? "",
      item.descriptionNl ?? "",
    );
}

export function queryItems(
  database: DatabaseSync,
  opts: {
    from: number;
    to: number;
    categories?: Category[];
    q?: string;
    limit?: number;
    /** Max items per category, most notable first. */
    perCategory?: number;
    /** "nl": rank items with a Dutch connection NL_BOOST times higher. */
    lens?: "nl" | null;
  },
): TimelineItem[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  let categoryClause = "";
  const categoryValues: string[] = [];
  if (opts.categories && opts.categories.length > 0) {
    categoryClause = `AND i.category IN (${opts.categories.map(() => "?").join(",")})`;
    categoryValues.push(...opts.categories);
  }

  if (opts.q && opts.q.trim()) {
    const q = `${opts.q.trim().replace(/["*]/g, " ")}*`;
    const rows = database
      .prepare(
        `
      SELECT i.*
      FROM items_fts f
      JOIN items i ON i.id = f.id
      WHERE items_fts MATCH ?
        AND i.start_year <= ?
        AND COALESCE(i.end_year, 100000) >= ?  -- NULL end = ongoing
        ${categoryClause}
      ORDER BY i.start_year ASC
      LIMIT ?
    `,
      )
      .all(q, opts.to, opts.from, ...categoryValues, limit) as ItemRow[];
    return rows.map(rowToItem);
  }

  // Level of detail: per category keep only the most notable items in the range.
  const perCategory = Math.min(Math.max(opts.perCategory ?? limit, 1), 2000);
  const rows = database
    .prepare(
      `
    SELECT * FROM (
      SELECT i.*, ROW_NUMBER() OVER (
        PARTITION BY i.category
        ORDER BY COALESCE(i.importance, ${SEED_IMPORTANCE})
          * ${opts.lens === "nl" ? `(CASE WHEN i.nl_link = 1 THEN ${NL_BOOST} ELSE 1 END)` : "1"} DESC,
          i.start_year ASC
      ) AS rn
      FROM items i
      WHERE i.start_year <= ?
        AND COALESCE(i.end_year, 100000) >= ?  -- NULL end = ongoing
        ${categoryClause}
    )
    WHERE rn <= ?
    ORDER BY start_year ASC
    LIMIT ?
  `,
    )
    .all(opts.to, opts.from, ...categoryValues, perCategory, limit) as ItemRow[];

  return rows.map(rowToItem);
}

/** Curated seed items have no sitelink count; rank them as fairly notable. */
const SEED_IMPORTANCE = 120;


// ---------- Dutch connection (Nederland-bril) ----------

/** Items whose Dutch connection hasn't been checked yet. */
export function getUncheckedNlQids(database: DatabaseSync, limit: number): string[] {
  return (
    database
      .prepare(`SELECT wikidata_id FROM items WHERE nl_link IS NULL AND wikidata_id IS NOT NULL LIMIT ?`)
      .all(limit) as Array<{ wikidata_id: string }>
  ).map((r) => r.wikidata_id);
}

/** Record the check: ids in `dutch` get 1, the other checked ids 0. */
export function setNlLinks(database: DatabaseSync, checked: string[], dutch: Set<string>): void {
  const stmt = database.prepare(`UPDATE items SET nl_link = ? WHERE wikidata_id = ?`);
  database.exec("BEGIN");
  try {
    for (const q of checked) stmt.run(dutch.has(q) ? 1 : 0, q);
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

export function getItemsByWikidataIds(database: DatabaseSync, qids: string[]): TimelineItem[] {
  if (qids.length === 0) return [];
  const rows = database
    .prepare(`SELECT * FROM items WHERE wikidata_id IN (${qids.map(() => "?").join(",")})`)
    .all(...qids) as ItemRow[];
  const byQid = new Map(rows.map((r) => [r.wikidata_id, r]));
  return qids.map((q) => byQid.get(q)).filter((r): r is ItemRow => !!r).map(rowToItem);
}

function normalizeWikiUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(url).replace(/^http:/, "https:");
  } catch {
    return url;
  }
}

/**
 * Store items discovered on Wikidata. An item that already exists (same Wikidata id, or a
 * curated seed item with the same English Wikipedia article) is enriched, not duplicated:
 * curated category and dates win; Dutch title/link and notability are filled in.
 */
export function upsertWikidataItems(database: DatabaseSync, items: WikidataItem[]): number {
  let inserted = 0;
  const findByQid = database.prepare(`SELECT * FROM items WHERE wikidata_id = ?`);
  const findByUrl = database.prepare(`SELECT * FROM items WHERE wikipedia_url = ? OR wikipedia_url = ?`);
  // Last resort for curated items whose Wikipedia URL has since changed (article renamed).
  const findByTitle = database.prepare(
    `SELECT * FROM items WHERE wikidata_id IS NULL AND category = ? AND ABS(start_year - ?) <= 1
       AND (LOWER(title) = LOWER(?) OR LOWER(title_nl) = LOWER(?)) LIMIT 1`,
  );
  const enrich = database.prepare(`
    UPDATE items SET
      wikidata_id = COALESCE(wikidata_id, ?),
      title_nl = COALESCE(title_nl, ?),
      wikipedia_url = COALESCE(wikipedia_url, ?),
      wikipedia_url_nl = COALESCE(wikipedia_url_nl, ?),
      importance = MAX(COALESCE(importance, 0), ?),
      -- Dynasties are often tagged both "dynasty" and "historical period": state wins.
      category = CASE WHEN id LIKE 'wd-%' AND category = 'period' AND ? = 'state' THEN 'state' ELSE category END
    WHERE id = ?`);

  database.exec("BEGIN");
  try {
    for (const it of items) {
      const url = normalizeWikiUrl(it.wikipediaUrl);
      const existing =
        (findByQid.get(it.qid) as ItemRow | undefined) ??
        (url ? (findByUrl.get(url, it.wikipediaUrl ?? url) as ItemRow | undefined) : undefined) ??
        (findByTitle.get(it.category, it.startYear, it.title, it.titleNl ?? it.title) as ItemRow | undefined);
      // Items from a Dutch tile are known to have a Dutch connection.
      const markNl = () => {
        if (it.nlLink) database.prepare(`UPDATE items SET nl_link = 1 WHERE wikidata_id = ?`).run(it.qid);
      };
      if (existing) {
        enrich.run(it.qid, it.titleNl, url, it.wikipediaUrlNl, it.sitelinks, it.category, existing.id);
        if (!existing.title_nl && it.titleNl) refreshFts(database, existing.id);
        markNl();
        continue;
      }
      upsertItem(database, {
        id: `wd-${it.qid}`,
        title: it.title,
        titleNl: it.titleNl,
        category: it.category,
        startYear: it.startYear,
        endYear: it.endYear,
        wikipediaUrl: url,
        wikipediaUrlNl: it.wikipediaUrlNl,
        wikidataId: it.qid,
      });
      database.prepare(`UPDATE items SET importance = ? WHERE id = ?`).run(it.sitelinks, `wd-${it.qid}`);
      markNl();
      inserted++;
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

function refreshFts(database: DatabaseSync, id: string): void {
  const row = getItem(database, id);
  if (!row) return;
  database.prepare(`DELETE FROM items_fts WHERE id = ?`).run(id);
  database
    .prepare(`INSERT INTO items_fts (id, title, title_nl, description, description_nl) VALUES (?, ?, ?, ?, ?)`)
    .run(id, row.title, row.title_nl ?? "", row.description ?? "", row.description_nl ?? "");
}

// ---------- Tile coverage & search cache ----------

export type TileState = { status: "ok" | "failed"; fetched_at: number };

export function getTileState(database: DatabaseSync, key: string): TileState | undefined {
  return database.prepare(`SELECT status, fetched_at FROM tiles WHERE key = ?`).get(key) as
    | TileState
    | undefined;
}

export function setTileState(database: DatabaseSync, key: string, status: "ok" | "failed", count: number): void {
  database
    .prepare(
      `INSERT INTO tiles (key, status, fetched_at, item_count) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at,
         item_count = excluded.item_count`,
    )
    .run(key, status, Date.now(), count);
}

const CLASS_TTL_MS = 90 * 24 * 3600_000;

/** SQLite-backed ClassCache (with an in-memory layer). */
export function createClassCache(database: DatabaseSync): ClassCache {
  const mem = new Map<string, string[]>();
  const get = database.prepare(`SELECT roots, fetched_at FROM class_roots WHERE qid = ?`);
  const put = database.prepare(
    `INSERT INTO class_roots (qid, roots, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(qid) DO UPDATE SET roots = excluded.roots, fetched_at = excluded.fetched_at`,
  );
  return {
    get(qid) {
      const hit = mem.get(qid);
      if (hit) return hit;
      const row = get.get(qid) as { roots: string; fetched_at: number } | undefined;
      if (!row || Date.now() - row.fetched_at > CLASS_TTL_MS) return undefined;
      const parents = JSON.parse(row.roots) as string[];
      mem.set(qid, parents);
      return parents;
    },
    set(qid, parents) {
      mem.set(qid, parents);
      put.run(qid, JSON.stringify(parents), Date.now());
    },
  };
}

export function getSearchCache(database: DatabaseSync, key: string): { qids: string[]; fetchedAt: number } | undefined {
  const row = database.prepare(`SELECT qids, fetched_at FROM search_cache WHERE key = ?`).get(key) as
    | { qids: string; fetched_at: number }
    | undefined;
  return row ? { qids: JSON.parse(row.qids) as string[], fetchedAt: row.fetched_at } : undefined;
}

export function setSearchCache(database: DatabaseSync, key: string, qids: string[]): void {
  database
    .prepare(
      `INSERT INTO search_cache (key, qids, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET qids = excluded.qids, fetched_at = excluded.fetched_at`,
    )
    .run(key, JSON.stringify(qids), Date.now());
}

export function getItem(database: DatabaseSync, id: string): ItemRow | undefined {
  return database.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
}

export function updateDescription(
  database: DatabaseSync,
  id: string,
  description: string,
  wikipediaUrl: string | null,
  lang: "en" | "nl" = "en",
): void {
  const [descCol, urlCol] = lang === "nl" ? ["description_nl", "wikipedia_url_nl"] : ["description", "wikipedia_url"];
  database
    .prepare(
      `UPDATE items
       SET ${descCol} = ?, ${urlCol} = COALESCE(?, ${urlCol}), extract_cached_at = ?
       WHERE id = ?`,
    )
    .run(description, wikipediaUrl, new Date().toISOString(), id);
  refreshFts(database, id);
}

export function getMeta(database: DatabaseSync) {
  const row = database
    .prepare(
      `SELECT
         MIN(start_year) AS min_year,
         MAX(COALESCE(end_year, start_year)) AS max_year,
         COUNT(*) AS count
       FROM items`,
    )
    .get() as { min_year: number | null; max_year: number | null; count: number };

  return {
    minYear: row.min_year ?? 0,
    maxYear: row.max_year ?? new Date().getFullYear(),
    count: row.count,
  };
}

// ---------- Linking curated items to Wikidata ----------

/** Curated items with a Wikipedia article but no Wikidata id yet. */
export function getUnlinkedItems(database: DatabaseSync): Array<{ id: string; wikipedia_url: string }> {
  return database
    .prepare(`SELECT id, wikipedia_url FROM items WHERE wikidata_id IS NULL AND wikipedia_url IS NOT NULL`)
    .all() as Array<{ id: string; wikipedia_url: string }>;
}

/**
 * Give a curated item its Wikidata id. If that id was already discovered as a separate
 * item (a duplicate), merge it in: the curated item keeps its category, dates and titles,
 * and takes over notability and any missing Dutch title/link. Returns true if merged.
 */
export function linkItemToWikidata(database: DatabaseSync, id: string, qid: string, canonicalUrl: string): boolean {
  database.exec("BEGIN");
  try {
    const dup = database.prepare(`SELECT * FROM items WHERE wikidata_id = ? AND id != ?`).get(qid, id) as
      | ItemRow
      | undefined;
    if (dup) {
      database.prepare(`DELETE FROM items_fts WHERE id = ?`).run(dup.id);
      database.prepare(`DELETE FROM items WHERE id = ?`).run(dup.id);
    }
    database
      .prepare(
        `UPDATE items SET
           wikidata_id = ?,
           wikipedia_url = ?,
           importance = MAX(COALESCE(importance, 0), ?),
           title_nl = COALESCE(title_nl, ?),
           wikipedia_url_nl = COALESCE(wikipedia_url_nl, ?)
         WHERE id = ?`,
      )
      .run(qid, normalizeWikiUrl(canonicalUrl), dup?.importance ?? 0, dup?.title_nl ?? null, dup?.wikipedia_url_nl ?? null, id);
    database.exec("COMMIT");
    refreshFts(database, id);
    return !!dup;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

// ---------- One-off data migrations ----------

export function hasRun(database: DatabaseSync, key: string): boolean {
  return database.prepare(`SELECT 1 FROM app_meta WHERE key = ?`).get(key) !== undefined;
}

export function markRun(database: DatabaseSync, key: string): void {
  database.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`).run(key, new Date().toISOString());
}

/** Wikidata ids of all items in a category. */
export function qidsInCategory(database: DatabaseSync, category: Category): string[] {
  return (
    database.prepare(`SELECT wikidata_id FROM items WHERE category = ? AND wikidata_id IS NOT NULL`).all(category) as Array<{
      wikidata_id: string;
    }>
  ).map((r) => r.wikidata_id);
}

export function setCategoryForQids(database: DatabaseSync, qids: string[], category: Category): number {
  if (qids.length === 0) return 0;
  const res = database
    .prepare(`UPDATE items SET category = ? WHERE wikidata_id IN (${qids.map(() => "?").join(",")})`)
    .run(category, ...qids);
  return Number(res.changes);
}

/** Forget fetched tiles for a category so they are fetched again with the current query. */
export function resetTiles(database: DatabaseSync, category: Category): void {
  database.prepare(`DELETE FROM tiles WHERE key LIKE ?`).run(`${category}:%`);
}

/** Remove discovered items by Wikidata id. Curated (seed) items are never removed. */
export function deleteDiscoveredItems(database: DatabaseSync, qids: string[]): number {
  if (qids.length === 0) return 0;
  const where = `id LIKE 'wd-%' AND wikidata_id IN (${qids.map(() => "?").join(",")})`;
  const ids = (database.prepare(`SELECT id FROM items WHERE ${where}`).all(...qids) as Array<{ id: string }>).map(
    (r) => r.id,
  );
  for (const id of ids) {
    database.prepare(`DELETE FROM items_fts WHERE id = ?`).run(id);
    database.prepare(`DELETE FROM items WHERE id = ?`).run(id);
  }
  return ids.length;
}
