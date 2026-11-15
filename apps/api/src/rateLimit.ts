import type { Context, MiddlewareHandler, Next } from "hono";

type Bucket = { times: number[] };

const buckets = new Map<string, Bucket>();

/** Drop empty buckets occasionally so memory stays bounded. */
const CLEAN_EVERY = 200;
let hitsSinceClean = 0;

function clean(now: number, windowMs: number): void {
  for (const [key, b] of buckets) {
    b.times = b.times.filter((t) => now - t < windowMs);
    if (b.times.length === 0) buckets.delete(key);
  }
}

/**
 * Client IP behind nginx (`X-Real-IP`) or the first `X-Forwarded-For` hop.
 * Falls back to a shared key when neither is present (direct local access).
 */
export function clientIp(c: Context): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return "local";
}

/**
 * Sliding-window rate limit: at most `limit` hits per `windowMs` for a given key.
 * Returns Retry-After seconds when blocked, otherwise null.
 */
export function take(key: string, limit: number, windowMs = 60_000): number | null {
  const now = Date.now();
  if (++hitsSinceClean >= CLEAN_EVERY) {
    hitsSinceClean = 0;
    clean(now, windowMs);
  }
  let b = buckets.get(key);
  if (!b) {
    b = { times: [] };
    buckets.set(key, b);
  }
  b.times = b.times.filter((t) => now - t < windowMs);
  if (b.times.length >= limit) {
    const oldest = b.times[0]!;
    return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
  }
  b.times.push(now);
  return null;
}

/** Hono middleware: limit requests per IP under `group` (e.g. "search"). */
export function rateLimit(group: string, limit: number, windowMs = 60_000): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const retryAfter = take(`${group}:${clientIp(c)}`, limit, windowMs);
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests", retryAfter }, 429);
    }
    return next();
  };
}
