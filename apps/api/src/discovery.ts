import { CATEGORIES, type Category } from "@historizon/shared";
import type { DatabaseSync } from "node:sqlite";
import {
  createClassCache,
  getSearchCache,
  getUnlinkedItems,
  linkItemToWikidata,
  getTileState,
  setSearchCache,
  setTileState,
  upsertWikidataItems,
} from "./db.js";
import { fetchByQids, fetchTile, type ClassCache } from "./wikidata.js";
import { resolveWikidataIds, searchWikipedia, type SearchHit, type WikiLang } from "./wikipedia.js";

/**
 * Viewport-driven discovery, like map tiles. Time is cut into tiles whose size depends on
 * the zoom level; each tile holds the most notable items (by Wikipedia sitelinks) that
 * START in it. Zooming in uses smaller tiles, so more (and less famous) items appear.
 * Every (category, level, start) tile is fetched once and remembered in SQLite.
 */

const LEVELS = [10, 50, 250] as const;
/** Beyond this span we only show what's already cached; tiles would be too coarse to help. */
const MAX_SPAN_FOR_FETCH = 1500;
const PER_TILE = 15;
const MIN_YEAR = -3000;
const NOW_YEAR = new Date().getFullYear();

const TILE_TTL_MS = 30 * 24 * 3600_000;
const FAILED_RETRY_MS = 10 * 60_000;
const SEARCH_TTL_MS = 7 * 24 * 3600_000;
/** Drop queued tiles nobody has asked for recently (the user scrolled past them). */
const STALE_WANT_MS = 30_000;
const MAX_TILES_PER_REQUEST = 40;

/**
 * Per category: minimum tile size and how far before the viewport to look, because
 * tiles hold items by START year and long-lived things (people, empires) begin earlier.
 */
const RULES: Record<Category, { minLevel: number; lookback: number }> = {
  person: { minLevel: 50, lookback: 80 },
  period: { minLevel: 250, lookback: 250 },
  war: { minLevel: 10, lookback: 10 },
  event: { minLevel: 10, lookback: 0 },
  invention: { minLevel: 10, lookback: 0 },
  artwork: { minLevel: 10, lookback: 0 },
  place: { minLevel: 10, lookback: 0 },
};

type Job = { level: number; start: number; categories: Set<Category>; wantedAt: number };

const tileKey = (c: Category, level: number, start: number) => `${c}:${level}:${start}`;
const groupKey = (level: number, start: number) => `${level}:${start}`;

function levelForSpan(span: number): number | null {
  if (span > MAX_SPAN_FOR_FETCH) return null;
  return LEVELS.find((l) => l >= span / 2) ?? LEVELS[LEVELS.length - 1];
}

export class Discovery {
  private queue = new Map<string, Job>();
  private running: Job | null = null;

  private readonly classCache: ClassCache;

  constructor(private readonly db: DatabaseSync) {
    this.classCache = createClassCache(db);
  }

  private isSettled(key: string): boolean {
    const st = getTileState(this.db, key);
    if (!st) return false;
    const age = Date.now() - st.fetched_at;
    return st.status === "ok" ? age < TILE_TTL_MS : age < FAILED_RETRY_MS;
  }

  /** Tiles (grouped per level+start) needed for a viewport. */
  plan(from: number, to: number, categories: readonly Category[] = CATEGORIES): Job[] {
    const base = levelForSpan(to - from);
    if (base === null) return [];
    const groups = new Map<string, Job>();
    for (const c of categories) {
      const { minLevel, lookback } = RULES[c];
      const level = Math.max(base, minLevel);
      const first = Math.max(MIN_YEAR, Math.floor((from - lookback) / level) * level);
      for (let s = first; s < to && s <= NOW_YEAR; s += level) {
        const k = groupKey(level, s);
        const job = groups.get(k) ?? { level, start: s, categories: new Set<Category>(), wantedAt: 0 };
        job.categories.add(c);
        groups.set(k, job);
      }
    }
    // Tiles inside the viewport first, then the look-back ones.
    return [...groups.values()]
      .sort((a, b) => Number(a.start + a.level <= from) - Number(b.start + b.level <= from) || b.start - a.start)
      .slice(0, MAX_TILES_PER_REQUEST);
  }

  /**
   * Make sure a viewport's tiles are (being) fetched. Returns how many tile groups are
   * still pending, so the client knows to poll again.
   */
  ensure(from: number, to: number, categories?: readonly Category[]): number {
    const now = Date.now();
    let pending = 0;
    const jobs = this.plan(from, to, categories);
    // Later in the list = lower priority; give earlier tiles a slightly newer timestamp.
    jobs.forEach((job, i) => {
      const missing = [...job.categories].filter((c) => !this.isSettled(tileKey(c, job.level, job.start)));
      if (missing.length === 0) return;
      pending++;
      const k = groupKey(job.level, job.start);
      if (this.running && groupKey(this.running.level, this.running.start) === k) return;
      const queued = this.queue.get(k);
      const wantedAt = now - i;
      if (queued) {
        missing.forEach((c) => queued.categories.add(c));
        queued.wantedAt = Math.max(queued.wantedAt, wantedAt);
      } else {
        this.queue.set(k, { level: job.level, start: job.start, categories: new Set(missing), wantedAt });
      }
    });
    this.pump();
    return pending;
  }

  private pump(): void {
    if (this.running) return;
    const now = Date.now();
    let next: Job | null = null;
    for (const [k, job] of this.queue) {
      if (now - job.wantedAt > STALE_WANT_MS) {
        this.queue.delete(k);
        continue;
      }
      if (!next || job.wantedAt > next.wantedAt) next = job;
    }
    if (!next) return;
    this.queue.delete(groupKey(next.level, next.start));
    this.running = next;
    void this.runJob(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async runJob(job: Job): Promise<void> {
    const cats = [...job.categories].filter((c) => !this.isSettled(tileKey(c, job.level, job.start)));
    if (cats.length === 0) return;
    const t0 = Date.now();
    try {
      const items = await fetchTile(cats, job.start, job.start + job.level, PER_TILE);
      const added = upsertWikidataItems(this.db, items);
      for (const c of cats) {
        setTileState(this.db, tileKey(c, job.level, job.start), "ok", items.filter((i) => i.category === c).length);
      }
      console.log(
        `[discovery] ${job.start}–${job.start + job.level} [${cats.join(",")}]: ${items.length} items, ${added} new (${Date.now() - t0} ms)`,
      );
    } catch (err) {
      for (const c of cats) setTileState(this.db, tileKey(c, job.level, job.start), "failed", 0);
      console.warn(`[discovery] tile ${job.start}–${job.start + job.level} failed:`, (err as Error).message);
    }
  }

  /** Fetch every tile for a range, sequentially (for the warm-up script). */
  async warm(from: number, to: number, windowSpan: number): Promise<void> {
    for (let s = from; s < to; s += windowSpan) {
      for (const job of this.plan(s, Math.min(s + windowSpan, to))) await this.runJob(job);
    }
  }

  /**
   * Link curated (seed) items to their Wikidata ids via their Wikipedia URL, following
   * redirects, and merge duplicates that discovery already created. Without an id, dedup
   * only works when URL or title match exactly, which breaks once an article is renamed.
   */
  async linkCuratedItems(): Promise<void> {
    const unlinked = getUnlinkedItems(this.db);
    if (unlinked.length === 0) return;
    const resolved = await resolveWikidataIds(unlinked.map((u) => u.wikipedia_url));
    let linked = 0;
    let merged = 0;
    for (const { id, wikipedia_url } of unlinked) {
      const hit = resolved.get(wikipedia_url);
      if (!hit) continue;
      linked++;
      if (linkItemToWikidata(this.db, id, hit.qid, hit.url)) merged++;
    }
    console.log(`[link] ${linked}/${unlinked.length} curated items linked to Wikidata, ${merged} duplicates merged`);
  }

  // ---------- Search ----------

  private searches = new Map<string, Promise<string[]>>();

  /**
   * Wikipedia full-text search, classified via Wikidata. Returns Wikidata ids in relevance
   * order; results are cached per language + query.
   */
  async search(q: string, lang: WikiLang): Promise<{ qids: string[]; remote: "cached" | "fetched" | "failed" }> {
    const norm = q.trim().toLowerCase().replace(/\s+/g, " ");
    // v2: fuzzy fallback + title-similarity ranking (older cached orderings are ignored).
    const key = `v2:${lang}:${norm}`;
    const cached = getSearchCache(this.db, key);
    if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL_MS) return { qids: cached.qids, remote: "cached" };

    let inflight = this.searches.get(key);
    if (!inflight) {
      inflight = (async () => {
        let hits = await searchWikipedia(norm, lang);
        // Wikipedia matches whole words, so a typo ("janssen" for "jansen") can miss the
        // obvious article entirely. If no hit's title resembles the query, retry fuzzily.
        if (!hits.some((h) => similarity(h.title, norm) >= CLOSE_MATCH)) {
          const fuzzy = norm
            .split(" ")
            .map((w) => (w.length >= 4 ? `${w}~` : w))
            .join(" ");
          if (fuzzy !== norm) hits = mergeHits(hits, await searchWikipedia(fuzzy, lang));
        }
        const ranked = rankHits(hits, norm);
        const items = await fetchByQids(
          ranked.map((h) => h.qid),
          this.classCache,
        );
        upsertWikidataItems(this.db, items);
        const known = new Set(items.map((i) => i.qid));
        const qids = ranked.map((h) => h.qid).filter((q) => known.has(q));
        setSearchCache(this.db, key, qids);
        return qids;
      })().finally(() => this.searches.delete(key));
      this.searches.set(key, inflight);
    }
    try {
      return { qids: await inflight, remote: "fetched" };
    } catch (err) {
      console.warn(`[search] "${norm}" failed:`, (err as Error).message);
      return { qids: cached?.qids ?? [], remote: "failed" };
    }
  }
}

// ---------- Search ranking helpers ----------

/** Titles at least this similar to the query count as "what the user meant". */
const CLOSE_MATCH = 0.8;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/\s*\(.*?\)\s*/g, " ") // drop qualifiers like "(zangeres)"
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length];
}

/** 0..1: how close a page title is to the query, spelling-wise. */
function similarity(title: string, query: string): number {
  const a = normalize(title);
  const b = normalize(query);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function mergeHits(first: SearchHit[], second: SearchHit[]): SearchHit[] {
  const seen = new Set(first.map((h) => h.qid));
  return [...first, ...second.filter((h) => !seen.has(h.qid))];
}

/** Near-exact title matches first (closest first); otherwise keep Wikipedia's order. */
function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  return hits
    .map((h, i) => ({ h, i, s: similarity(h.title, query) }))
    .sort((x, y) => {
      const xClose = x.s >= CLOSE_MATCH;
      const yClose = y.s >= CLOSE_MATCH;
      if (xClose !== yClose) return xClose ? -1 : 1;
      if (xClose && x.s !== y.s) return y.s - x.s;
      return x.i - y.i;
    })
    .map((x) => x.h);
}
