import type { SaleTransaction } from "./earnings";
import type { StorageLike } from "./history";

// Sale history cached in the browser, so the earnings report (and especially
// "All time") doesn't page through every sale on each load. Roblox only pages
// newest-first, so a refresh re-reads from today back to a boundary and
// replaces that window in the cache.

const DAY = 86_400_000;
/** A refresh also re-reads a day before the last one, in case Roblox lists a sale late. */
export const REFRESH_OVERLAP_MS = DAY;
/** Sales stay pending for up to 30 days; anything still pending after this is ignored. */
export const PENDING_MAX_DAYS = 35;
/**
 * The most sales kept in the browser per creator (about 15 MB). Past this the
 * oldest are dropped, so reading the cache never stalls the page.
 */
export const MAX_STORED_SALES = 250_000;

export interface SalesCacheEntry {
  /** Newest first. */
  sales: SaleTransaction[];
  /** Oldest moment the cache is complete back to; null means the whole history. */
  coveredFrom: string | null;
  /** When the cache was last refreshed (it's complete up to here). */
  updatedAt: string;
  /** Roblox's cursor for carrying on past `coveredFrom`, if we have one. */
  olderCursor?: string | null;
}

export interface FetchOutcome {
  transactions: SaleTransaction[];
  reachedSince: boolean;
  reachedEnd: boolean;
  resumeCursor?: string | null;
}

/** True when the cache is complete back to `want` (null = the whole history). */
export const cacheCovers = (cache: SalesCacheEntry, want: Date | null) =>
  cache.coveredFrom === null || (want !== null && new Date(cache.coveredFrom) <= want);

/**
 * How far back to page this time. When the cache already covers what's
 * wanted, that's only the sales since the last refresh, plus any still
 * pending (Roblox may have released them since). Otherwise it's all the way
 * back to `want` (null = everything).
 */
export function planFetch(cache: SalesCacheEntry | null, want: Date | null, now: Date): Date | null {
  if (!cache || !cacheCovers(cache, want)) return want;
  const pendingLimit = now.getTime() - PENDING_MAX_DAYS * DAY;
  let from = new Date(cache.updatedAt).getTime() - REFRESH_OVERLAP_MS;
  for (const s of cache.sales) {
    if (!s.isPending) continue;
    const created = new Date(s.created).getTime();
    if (created >= pendingLimit) from = Math.min(from, created);
  }
  return new Date(Math.min(from, now.getTime()));
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

  // Where the cache now ends, and the cursor for going past it.
  let coveredFrom: string | null;
  let olderCursor: string | null = null;
  if (windowStart === null) coveredFrom = null;
  else if (contiguous && cache!.coveredFrom === null) coveredFrom = null;
  else if (contiguous && new Date(cache!.coveredFrom!) < windowStart) {
    coveredFrom = cache!.coveredFrom;
    olderCursor = cache!.olderCursor ?? null;
  } else {
    coveredFrom = windowStart.toISOString();
    olderCursor = fetched.resumeCursor ?? null;
  }

  return { sales, coveredFrom, updatedAt: now.toISOString(), olderCursor };
}

/**
 * Folds in older sales, paged from the cache's `olderCursor` back to
 * `stopAt` (null = everything). The newer end of the cache is unchanged.
 */
export function mergeOlder(cache: SalesCacheEntry, fetched: FetchOutcome, stopAt: Date | null): SalesCacheEntry {
  // The resumed page can repeat a few sales the cache already has. Those can
  // only be at its older end, so this runs on every page without slowing down.
  const newestFetched = fetched.transactions[0]?.created;
  const seen = new Set<string>();
  for (let i = cache.sales.length - 1; i >= 0 && newestFetched && cache.sales[i].created <= newestFetched; i--) seen.add(cache.sales[i].id);
  const older = fetched.transactions.filter((s) => !seen.has(s.id));
  const coveredFrom = fetched.reachedEnd
    ? null
    : fetched.reachedSince && stopAt
      ? stopAt.toISOString()
      : (fetched.transactions.at(-1)?.created ?? cache.coveredFrom);
  const sales = [...cache.sales, ...older];
  // Normally they all come after the cache's oldest sale; sort only if Roblox's paging shifted.
  const last = cache.sales.at(-1);
  if (last && older.length && older[0].created > last.created) sales.sort((x, y) => (x.created < y.created ? 1 : x.created > y.created ? -1 : 0));
  return { ...cache, sales, coveredFrom, olderCursor: fetched.resumeCursor ?? null };
}

/**
 * How sales are saved: each item and buyer once, and each sale as a short row
 * pointing at them. About a quarter of the size of plain objects.
 */
export interface StoredSales {
  v: 2;
  coveredFrom: string | null;
  updatedAt: string;
  olderCursor?: string | null;
  /** [id, name, type] */
  items: [number, string, string][];
  /** [id, name] */
  buyers: [number, string][];
  /** [sale id, created, robux, item index, buyer index, pending (1) or not (0)] */
  rows: [string, string, number, number, number, 0 | 1][];
}

export function packSales(entry: SalesCacheEntry): StoredSales {
  let { sales, coveredFrom, olderCursor = null } = entry;
  if (sales.length > MAX_STORED_SALES) {
    sales = sales.slice(0, MAX_STORED_SALES);
    coveredFrom = sales.at(-1)!.created;
    olderCursor = null; // it pointed past the sales that were dropped
  }
  const items: StoredSales["items"] = [];
  const buyers: StoredSales["buyers"] = [];
  const itemIndex = new Map<string, number>();
  const buyerIndex = new Map<string, number>();
  const indexOf = <T>(map: Map<string, number>, list: T[], key: string, value: T) => {
    let i = map.get(key);
    if (i === undefined) map.set(key, (i = list.push(value) - 1));
    return i;
  };
  const rows = sales.map((s): StoredSales["rows"][number] => [
    s.id,
    s.created,
    s.robux,
    indexOf(itemIndex, items, `${s.item.type}:${s.item.id}:${s.item.name}`, [s.item.id, s.item.name, s.item.type]),
    indexOf(buyerIndex, buyers, `${s.buyer.id}:${s.buyer.name}`, [s.buyer.id, s.buyer.name]),
    s.isPending ? 1 : 0,
  ]);
  return { v: 2, coveredFrom, updatedAt: entry.updatedAt, olderCursor, items, buyers, rows };
}

export function unpackSales(stored: StoredSales): SalesCacheEntry {
  // Sales of the same item share one object, which also keeps memory down.
  const items = stored.items.map(([id, name, type]) => ({ id, name, type }));
  const buyers = stored.buyers.map(([id, name]) => ({ id, name }));
  return {
    coveredFrom: stored.coveredFrom,
    updatedAt: stored.updatedAt,
    olderCursor: stored.olderCursor ?? null,
    sales: stored.rows.map(([id, created, robux, item, buyer, pending]) => ({ id, created, robux, isPending: pending === 1, item: items[item], buyer: buyers[buyer] })),
  };
}

const PREFIX = "sales:";

export class SalesCache {
  constructor(private storage: StorageLike) {}

  async read(creatorKey: string): Promise<SalesCacheEntry | null> {
    try {
      const stored = (await this.storage.get(PREFIX + creatorKey)) as StoredSales | SalesCacheEntry | undefined;
      if (!stored) return null;
      // Entries saved before the compact format are plain objects.
      return "v" in stored ? unpackSales(stored) : stored;
    } catch {
      return null;
    }
  }

  async write(creatorKey: string, entry: SalesCacheEntry): Promise<void> {
    try {
      await this.storage.set(PREFIX + creatorKey, packSales(entry));
    } catch {
      // A full or unavailable cache only means the next load re-fetches.
    }
  }

  /** Bytes the saved sales take up for every creator, or null if the browser can't tell. */
  async size(): Promise<number | null> {
    try {
      return await this.storage.bytesInUse(await this.storage.keys(PREFIX));
    } catch {
      return null;
    }
  }

  /** Forgets saved sales for every creator. */
  async clear(): Promise<void> {
    for (const key of await this.storage.keys(PREFIX)) await this.storage.remove(key);
  }
}
