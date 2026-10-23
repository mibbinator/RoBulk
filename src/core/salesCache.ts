import type { SaleTransaction } from "./earnings";
import type { StorageLike } from "./history";

// Sale history cached in the browser, so the earnings report (and especially
// "All time") doesn't page through every sale on each load. Roblox only pages
// newest-first, so a refresh re-reads from today back to a boundary and
// replaces that window in the cache.

const DAY = 86_400_000;
/** Recent sales are re-read every time: they stay pending for up to 30 days. */
export const REFRESH_DAYS = 35;

export interface SalesCacheEntry {
  /** Newest first. */
  sales: SaleTransaction[];
  /** Oldest moment the cache is complete back to; null means the whole history. */
  coveredFrom: string | null;
  /** When the cache was last refreshed (it's complete up to here). */
  updatedAt: string;
}

export interface FetchOutcome {
  transactions: SaleTransaction[];
  reachedSince: boolean;
  reachedEnd: boolean;
}

/** True when the cache is complete back to `want` (null = the whole history). */
export const cacheCovers = (cache: SalesCacheEntry, want: Date | null) =>
  cache.coveredFrom === null || (want !== null && new Date(cache.coveredFrom) <= want);

/**
 * How far back to page this time: a short refresh when the cache already
 * covers what's wanted, otherwise all the way to `want` (null = everything).
 */
export function planFetch(cache: SalesCacheEntry | null, want: Date | null, now: Date): Date | null {
  if (!cache || !cacheCovers(cache, want)) return want;
  const refreshFrom = now.getTime() - REFRESH_DAYS * DAY;
  const newest = cache.sales[0] ? new Date(cache.sales[0].created).getTime() : refreshFrom;
  return new Date(Math.min(newest, refreshFrom));
}

/** Folds a fetch (paged from now back to `stopAt`) into the cache. */
export function mergeFetched(cache: SalesCacheEntry | null, fetched: FetchOutcome, stopAt: Date | null, now: Date): SalesCacheEntry {
  // The window the fetch fully re-read: from its oldest point up to now.
  const windowStart: Date | null = fetched.reachedEnd
    ? null
    : fetched.reachedSince && stopAt
      ? stopAt
      : new Date(fetched.transactions.at(-1)?.created ?? now.toISOString());

  // Older cached sales still line up if the cache was complete up to the window.
  const contiguous = !!cache && windowStart !== null && new Date(cache.updatedAt) >= windowStart;
  const kept = contiguous ? cache!.sales.filter((s) => new Date(s.created) < windowStart!) : [];

  const seen = new Set<string>();
  const sales = [...fetched.transactions, ...kept]
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

  let coveredFrom: string | null;
  if (windowStart === null) coveredFrom = null;
  else if (contiguous && cache!.coveredFrom === null) coveredFrom = null;
  else if (contiguous && new Date(cache!.coveredFrom!) < windowStart) coveredFrom = cache!.coveredFrom;
  else coveredFrom = windowStart.toISOString();

  return { sales, coveredFrom, updatedAt: now.toISOString() };
}

export class SalesCache {
  constructor(private storage: StorageLike) {}

  async read(creatorKey: string): Promise<SalesCacheEntry | null> {
    try {
      return ((await this.storage.get(`sales:${creatorKey}`)) as SalesCacheEntry | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async write(creatorKey: string, entry: SalesCacheEntry): Promise<void> {
    try {
      await this.storage.set(`sales:${creatorKey}`, entry);
    } catch {
      // A full or unavailable cache only means the next load re-fetches.
    }
  }
}
