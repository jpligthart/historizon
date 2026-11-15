/**
 * Small politeness layer for outbound requests: caps concurrency, spaces requests out,
 * and backs off when a server answers 429/503 (honouring Retry-After).
 */
export class Throttle {
  private active = 0;
  private lastStart = 0;
  private pausedUntil = 0;
  private waiting: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly name: string,
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  /** How long this service is still paused after a 429, in ms. */
  pausedFor(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  private pump(): void {
    if (this.timer || this.active >= this.concurrency || this.waiting.length === 0) return;
    const now = Date.now();
    const wait = Math.max(this.lastStart + this.minIntervalMs - now, this.pausedUntil - now, 0);
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    this.active++;
    this.lastStart = now;
    this.waiting.shift()!();
    this.pump();
  }
}

/** Wikimedia asks for a UA with contact info; set WIKI_USER_AGENT in .env for real use. */
const DEFAULT_UA = "Historizon/0.1 (self-hosted instance; operator has not set WIKI_USER_AGENT)";

export function userAgent(): string {
  return process.env.WIKI_USER_AGENT?.trim() || DEFAULT_UA;
}

function retryAfterMs(res: Response, attempt: number, baseMs: number): number {
  const header = res.headers.get("retry-after");
  const secs = header ? Number(header) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 10 * 60_000);
  return baseMs * 2 ** attempt;
}

export class RateLimitedError extends Error {}

/** fetch() through a throttle, with a timeout and limited retries on 429/5xx. */
export async function politeFetch(
  throttle: Throttle,
  url: string,
  init: RequestInit & {
    timeoutMs?: number;
    /** Total attempts (default 3). */
    retries?: number;
    /** Back-off when the server gives no Retry-After; doubles per attempt (default 2 s). */
    backoffMs?: number;
    /**
     * Fail fast instead of waiting longer than this for a paused service (for requests a
     * user is waiting on). Default: wait.
     */
    maxWaitMs?: number;
  } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, retries = 3, backoffMs = 2000, maxWaitMs = Infinity, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("User-Agent", userAgent());
  headers.set("Accept-Encoding", "gzip");

  for (let attempt = 0; attempt < retries; attempt++) {
    if (throttle.pausedFor() > maxWaitMs) {
      throw new RateLimitedError(`[${throttle.name}] paused for ${Math.round(throttle.pausedFor() / 1000)}s`);
    }
    const res = await throttle.run(() =>
      fetch(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) }),
    );
    if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
      const ms = retryAfterMs(res, attempt, backoffMs);
      // Pause every request to this service, not just this one.
      throttle.pause(ms);
      console.warn(`[${throttle.name}] ${res.status}, pausing ${Math.round(ms / 1000)}s`);
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new RateLimitedError(`[${throttle.name}] rate limited / unavailable: ${url.slice(0, 120)}`);
}

/** Shared throttles, one per upstream service. */
export const throttles = {
  /** Wikidata SPARQL (QLever by default). */
  // QLever starts answering 429 at roughly 8+ queries a minute; stay well under that.
  sparql: new Throttle("sparql", 1, Number(process.env.SPARQL_MIN_INTERVAL_MS ?? 6000)),
  /** Wikidata Action API (wbgetentities). */
  wikidata: new Throttle("wikidata", 1, 200),
  /** Wikidata Action API for background upkeep (person domains): slow, so it doesn't trip 429s. */
  wikidataBackground: new Throttle("wikidata-bg", 1, 1500),
  /** Official Wikidata Query Service, only for small class-hierarchy lookups. */
  wdqs: new Throttle("wdqs", 1, 1000),
  /** Wikipedia / MediaWiki Action API. */
  wikipedia: new Throttle("wikipedia", 1, 500),
};
