import type { SaleTransaction } from "../core/earnings";
import { RobloxApiError, type RobloxClient } from "./http";
import type { Creator } from "./types";

const ECONOMY = "https://economy.roblox.com";
/** The transaction records service the Creator Dashboard's Transactions page uses. */
const RECORDS = "https://apis.roblox.com/transaction-records-api";
const ITEMCONFIG = "https://itemconfiguration.roblox.com";

interface RawTransaction {
  id?: number | string;
  idHash?: string;
  created: string;
  isPending?: boolean;
  agent?: { id: number; type: string; name: string };
  details?: { id: number; name: string; type: string };
  currency?: { amount: number; type: string };
}

interface TransactionPage {
  data: RawTransaction[];
  nextPageCursor: string | null;
}

/** A sale as the transaction records service lists it. */
export interface RawRecord {
  counterParty?: { type: string; id: string | number } | null;
  ledgerReason?: string;
  /** "Active" while Roblox holds the Robux, "Released"/"Settled" once paid, "Cancelled" if refunded. */
  holdStatus?: string;
  amount?: string | number;
  details?: {
    productId?: number | string;
    productName?: string;
    /** 2/3 avatar item, 4 developer product, 5 private server, 6 game pass, 7 bundle, 8-10 collectible. */
    productTypeId?: number | string;
    productTargetId?: number | string;
    productUniverseId?: number | string;
    assetId?: number | string;
    collectibleItemTargetId?: number | string;
  } | null;
  createdTime: string;
}

interface RecordsPage {
  transactions?: RawRecord[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Reads a sale from the transaction records service; null for anything that isn't a paid-for sale. */
export function toSaleFromRecord(raw: RawRecord): SaleTransaction | null {
  const d = raw.details;
  const robux = num(raw.amount);
  const status = raw.holdStatus?.toLowerCase();
  if (!d || robux === undefined || robux <= 0 || status === "cancelled" || status === "canceled") return null;
  const typeId = num(d.productTypeId);
  const target = num(d.productTargetId);
  const universeId = num(d.productUniverseId);
  let item: SaleTransaction["item"];
  if (typeId === 6) item = { id: target ?? num(d.productId) ?? 0, name: d.productName ?? "Game pass", type: "GamePass", universeId };
  else if (typeId === 4) item = { id: target ?? num(d.productId) ?? 0, name: d.productName ?? "Developer product", type: "DeveloperProduct", universeId };
  else if (typeId === 5) item = { id: universeId ?? num(d.productId) ?? 0, name: d.productName ?? "Private server", type: "PrivateServer", universeId };
  else if (typeId === 7) item = { id: target ?? num(d.productId) ?? 0, name: d.productName ?? "Bundle", type: "Bundle" };
  else item = { id: num(d.assetId) ?? num(d.collectibleItemTargetId) ?? target ?? 0, name: d.productName ?? "Item", type: "Asset" };
  const buyerId = num(raw.counterParty?.id) ?? 0;
  return {
    // The service doesn't give sales an id; this is stable for the same sale.
    id: `rec:${raw.createdTime}:${buyerId}:${d.productId ?? item.id}`,
    created: raw.createdTime,
    isPending: status !== "released" && status !== "settled",
    robux,
    // Names aren't included; the report looks them up for the buyers it shows.
    buyer: { id: buyerId, name: "" },
    item,
  };
}

export function toSaleTransaction(raw: RawTransaction): SaleTransaction | null {
  if (!raw.details || !raw.currency || raw.currency.type !== "Robux") return null;
  return {
    id: String(raw.idHash ?? raw.id ?? `${raw.created}:${raw.details.id}`),
    created: raw.created,
    isPending: raw.isPending ?? false,
    robux: raw.currency.amount,
    buyer: { id: raw.agent?.id ?? 0, name: raw.agent?.name ?? "Unknown" },
    item: { id: raw.details.id, name: raw.details.name, type: raw.details.type },
  };
}

/** Waits `ms`, or less if `signal` aborts first. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

async function getWithRetry<T>(client: RobloxClient, url: string, { onRateLimited, signal }: { onRateLimited?: () => void; signal?: AbortSignal } = {}, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.json<T>(url);
    } catch (e) {
      if (attempt >= attempts || signal?.aborted) throw e;
      // Too many requests: wait as long as Roblox asks, and slow down.
      if (e instanceof RobloxApiError && e.status === 429) {
        onRateLimited?.();
        await sleep(e.retryAfterMs ?? 3000 * 2 ** attempt, signal);
        continue;
      }
      // A Roblox server error or a dropped connection is usually gone on the next try.
      const transient = e instanceof RobloxApiError ? e.status >= 500 : e instanceof TypeError;
      if (!transient) throw e;
      await sleep(1500 * 2 ** attempt, signal);
    }
  }
}

/** First pause between pages after Roblox says "too many requests"; it doubles on each further one. */
export const RATE_LIMITED_PACE_MS = 350;
const MAX_PACE_MS = 4000;

export interface TransactionProgress {
  pages: number;
  sales: number;
  oldest: string | null;
}

export interface TransactionResult {
  transactions: SaleTransaction[];
  /** Paging stopped at `since`. */
  reachedSince: boolean;
  /** Paging reached the very first sale. */
  reachedEnd: boolean;
  /** The page limit or a stop request cut the history short. */
  truncated: boolean;
  /**
   * Where to carry on paging back from next time (Roblox's cursor for the page
   * paging stopped on, or the one after it), or null when there's nothing older.
   */
  resumeCursor: string | null;
}

/** One page of sales from one of Roblox's two transaction services, newest first. */
interface SalesSource {
  name: "rec" | "eco";
  page(cursor: string, opts: { onRateLimited: () => void; signal?: AbortSignal }): Promise<{ rows: { created: string; sale: SaleTransaction | null }[]; next: string | null }>;
}

/** The records service the dashboard uses. Its cursors mark a place in the list, so they still work on a later visit. */
function recordsSource(client: RobloxClient, creator: Creator): SalesSource {
  const base = `${RECORDS}/v2/${creator.type === "Group" ? "groups" : "users"}/${creator.id}/transactions`;
  let withTimes = false;
  return {
    name: "rec",
    async page(cursor, opts) {
      const params = new URLSearchParams({ limit: "100", ledgerReason: "SaleOfGood" });
      if (withTimes) {
        params.set("startTimeMillis", "0");
        params.set("endTimeMillis", String(Date.now()));
      }
      if (cursor) params.set("cursor", cursor);
      let res: RecordsPage;
      try {
        res = await getWithRetry<RecordsPage>(client, `${base}?${params}`, opts);
      } catch (e) {
        // Some accounts may need a time range; ask again with one that covers everything.
        if (!withTimes && e instanceof RobloxApiError && e.status === 400 && /missing request parameter/i.test(e.message)) {
          withTimes = true;
          return this.page(cursor, opts);
        }
        throw e;
      }
      if (!Array.isArray(res.transactions)) throw new RobloxApiError("Unexpected answer from the transaction records service", 502);
      return {
        rows: res.transactions.map((r) => ({ created: r.createdTime, sale: toSaleFromRecord(r) })),
        next: res.hasMore === false ? null : (res.nextCursor ?? null),
      };
    },
  };
}

/** The older economy service. Its cursors don't last between visits. */
function economySource(client: RobloxClient, creator: Creator): SalesSource {
  const base = `${ECONOMY}/v2/${creator.type === "Group" ? "groups" : "users"}/${creator.id}/transactions`;
  return {
    name: "eco",
    async page(cursor, opts) {
      const params = new URLSearchParams({ transactionType: "Sale", limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const res = await getWithRetry<TransactionPage>(client, `${base}?${params}`, opts);
      return { rows: res.data.map((r) => ({ created: r.created, sale: toSaleTransaction(r) })), next: res.nextPageCursor };
    },
  };
}

/** Creators whose sales the records service wouldn't give this page visit; the economy service is used for them instead. */
const recordsRefused = new Set<string>();
/** Forgets which creators fell back (for tests). */
export function resetSalesSources() {
  recordsRefused.clear();
}

/** The records service refused (not a passing problem): worth trying the economy service instead. */
const refused = (e: unknown) => e instanceof RobloxApiError && [400, 401, 403, 404, 502].includes(e.status);

/**
 * Sale transactions from newest back to `since` (or all of them when `since`
 * is null). Roblox only pages through history, newest first, so a page cap
 * keeps very busy stores from running for ages. `fromCursor` starts further
 * back instead, where an earlier load's `resumeCursor` said to.
 *
 * Sales come from the transaction records service the dashboard uses, whose
 * cursors still work on a later visit; if it won't give them, from the older
 * economy service. Cursors are tagged with the service they came from
 * ("rec:…" or "eco:…"; untagged ones are from before, and so economy ones).
 *
 * Pages are fetched back to back. If Roblox rate-limits us, we wait as it
 * asks, then pause between pages for the rest of the load (longer each time
 * it happens again), so we don't keep using up the requests the Creator
 * Dashboard itself needs.
 */
export async function listSales(
  client: RobloxClient,
  creator: Creator,
  /** Where to stop; a function is asked again on every page, so a running load can be told to go further back. */
  stopAt: Date | null | (() => Date | null),
  {
    maxPages = 60,
    fromCursor = "",
    onProgress,
    onPage,
    beforePage,
    signal,
  }: {
    maxPages?: number;
    fromCursor?: string;
    onProgress?: (p: TransactionProgress) => void;
    /** Everything so far after each page that isn't the last, so it can be saved as it arrives. */
    onPage?: (soFar: TransactionResult) => void;
    /** Awaited before each page, so a lower-priority load can wait its turn. */
    beforePage?: () => Promise<void> | void;
    signal?: AbortSignal;
  } = {},
): Promise<TransactionResult> {
  const key = `${creator.type}:${creator.id}`;
  const tagged = /^(rec|eco):/.exec(fromCursor);
  let source =
    (tagged ? tagged[1] === "rec" : !fromCursor && !recordsRefused.has(key)) ? recordsSource(client, creator) : economySource(client, creator);
  let cursor = tagged ? fromCursor.slice(4) : fromCursor;

  const transactions: SaleTransaction[] = [];
  let pace = 0;
  // "" is the newest page, which is no help as a place to carry on from.
  const resume = (c: string) => (c ? `${source.name}:${c}` : null);
  const onRateLimited = () => (pace = pace ? Math.min(MAX_PACE_MS, pace * 2) : RATE_LIMITED_PACE_MS);
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) break;
    if (beforePage) {
      await beforePage();
      if (signal?.aborted) break;
    }
    let res: Awaited<ReturnType<SalesSource["page"]>>;
    try {
      res = await source.page(cursor, { onRateLimited, signal });
    } catch (e) {
      if (signal?.aborted) break; // stopped while waiting out a rate limit: keep what's loaded
      // Starting from the newest sale and the records service won't help: use the economy service.
      if (source.name === "rec" && page === 0 && !cursor && refused(e)) {
        recordsRefused.add(key);
        source = economySource(client, creator);
        page--;
        continue;
      }
      throw e;
    }
    const since = typeof stopAt === "function" ? stopAt() : stopAt;
    let reachedSince = false;
    for (const row of res.rows) {
      if (since && new Date(row.created) < since) {
        reachedSince = true;
        break;
      }
      if (row.sale) transactions.push(row.sale);
    }
    onProgress?.({ pages: page + 1, sales: transactions.length, oldest: transactions.at(-1)?.created ?? null });
    // This page has the sales just past `since`, so a longer load starts here.
    if (reachedSince) return { transactions, reachedSince, reachedEnd: false, truncated: false, resumeCursor: resume(cursor) };
    if (!res.next) return { transactions, reachedSince: false, reachedEnd: true, truncated: false, resumeCursor: null };
    cursor = res.next;
    onPage?.({ transactions: [...transactions], reachedSince: false, reachedEnd: false, truncated: true, resumeCursor: resume(cursor) });
    if (pace) await sleep(pace, signal);
  }
  return { transactions, reachedSince: false, reachedEnd: false, truncated: true, resumeCursor: resume(cursor) };
}

/** Current Robux balance (group funds or the user's own balance). */
export async function getBalance(client: RobloxClient, creator: Creator): Promise<number | null> {
  const url =
    creator.type === "Group" ? `${ECONOMY}/v1/groups/${creator.id}/currency` : `${ECONOMY}/v1/users/${creator.id}/currency`;
  try {
    const res = await client.json<{ robux?: number }>(url);
    return res.robux ?? null;
  } catch {
    return null;
  }
}

/** Share of a marketplace sale the creator keeps, in percent (as the dashboard computes it). */
export async function getCreatorSplitPercent(client: RobloxClient, assetId: number, price: number): Promise<number | null> {
  const params = new URLSearchParams({
    TargetType: "0",
    TargetID: String(assetId),
    CollectibleItemType: "2",
    MinimumPrice: String(Math.max(1, price)),
    PriceOffset: "0",
    PurchasePlatform: "1",
  });
  try {
    const res = await client.json<{ RevenueSplit?: { creatorSplitPercentage?: number }; revenueSplit?: { creatorSplitPercentage?: number } }>(
      `${ITEMCONFIG}/v1/collectibles/revenue-split?${params}`,
    );
    return (res.RevenueSplit ?? res.revenueSplit)?.creatorSplitPercentage ?? null;
  } catch {
    return null;
  }
}

/** Roblox's standard share for game pass and developer product sales. */
export const EXPERIENCE_CREATOR_SHARE = 70;
