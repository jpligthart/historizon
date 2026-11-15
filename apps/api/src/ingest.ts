/**
 * Warm the cache: fetch Wikidata tiles for a range ahead of time, politely and sequentially.
 *
 *   npm run ingest -- <fromYear> <toYear> [viewSpan]
 *   npm run ingest -- 1800 2026 50     # tiles as seen at the 50-year zoom level
 */
import { openDb } from "./db.js";
import { Discovery } from "./discovery.js";

const from = Number(process.argv[2] ?? 1900);
const to = Number(process.argv[3] ?? new Date().getFullYear());
const span = Number(process.argv[4] ?? 50);

if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || !(span > 0)) {
  console.error("Usage: npm run ingest -- <fromYear> <toYear> [viewSpan]");
  process.exit(1);
}

console.log(`Warming tiles ${from}–${to} at view span ${span}…`);
await new Discovery(openDb()).warm(from, to, span);
console.log("Done.");
