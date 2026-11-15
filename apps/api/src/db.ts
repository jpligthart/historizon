import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Category, TimelineItem } from "@historizon/shared";
import { CATEGORIES } from "@historizon/shared";

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

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS items (
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
      extract_cached_at TEXT
    );

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
  `);
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
  };
}

export function upsertItem(
  database: DatabaseSync,
  item: Omit<TimelineItem, "description" | "descriptionNl" | "descriptionFromWikipedia"> & {
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
      title_nl = excluded.title_nl,
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

  const rows = database
    .prepare(
      `
    SELECT i.*
    FROM items i
    WHERE i.start_year <= ?
      AND COALESCE(i.end_year, 100000) >= ?  -- NULL end = ongoing
      ${categoryClause}
    ORDER BY i.start_year ASC
    LIMIT ?
  `,
    )
    .all(opts.to, opts.from, ...categoryValues, limit) as ItemRow[];

  return rows.map(rowToItem);
}

export function getItem(database: DatabaseSync, id: string): ItemRow | undefined {
  return database.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
}

export function updateDescription(
  database: DatabaseSync,
  id: string,
  description: string,
  wikipediaUrl: string | null,
): void {
  database
    .prepare(
      `UPDATE items
       SET description = ?, wikipedia_url = COALESCE(?, wikipedia_url), extract_cached_at = ?
       WHERE id = ?`,
    )
    .run(description, wikipediaUrl, new Date().toISOString(), id);

  const row = getItem(database, id);
  if (!row) return;
  database.prepare(`DELETE FROM items_fts WHERE id = ?`).run(id);
  database
    .prepare(
      `INSERT INTO items_fts (id, title, title_nl, description, description_nl)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, row.title, row.title_nl ?? "", description, row.description_nl ?? "");
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
