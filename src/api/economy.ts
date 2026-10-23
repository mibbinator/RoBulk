import type { SaleTransaction } from "../core/earnings";
import { RobloxApiError, type RobloxClient } from "./http";
import type { Creator } from "./types";

const ECONOMY = "https://economy.roblox.com";
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
      if (!(e instanceof RobloxApiError) || e.status !== 429 || attempt >= attempts || signal?.aborted) throw e;
      onRateLimited?.();
      await sleep(e.retryAfterMs ?? 3000 * 2 ** attempt, signal);
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

/**
 * Sale transactions from newest back to `since` (or all of them when `since`
 * is null). Roblox only pages through history, newest first, so a page cap
 * keeps very busy stores from running for ages. `fromCursor` starts further
 * back instead, where an earlier load's `resumeCursor` said to.
 *
 * Pages are fetched back to back. If Roblox rate-limits us, we wait as it
 * asks, then pause between pages for the rest of the load (longer each time
 * it happens again), so we don't keep using up the requests the Creator
 * Dashboard itself needs.
 */
export async function listSales(
  client: RobloxClient,
  creator: Creator,
  since: Date | null,
  {
    maxPages = 60,
    fromCursor = "",
    onProgress,
    onPage,
    signal,
  }: {
    maxPages?: number;
    fromCursor?: string;
    onProgress?: (p: TransactionProgress) => void;
    /** Everything so far after each page that isn't the last, so it can be saved as it arrives. */
    onPage?: (soFar: TransactionResult) => void;
    signal?: AbortSignal;
  } = {},
): Promise<TransactionResult> {
  const base =
    creator.type === "Group"
      ? `${ECONOMY}/v2/groups/${creator.id}/transactions`
      : `${ECONOMY}/v2/users/${creator.id}/transactions`;
  const transactions: SaleTransaction[] = [];
  let cursor = fromCursor;
  let pace = 0;
  // "" is the newest page, which is no help as a place to carry on from.
  const resume = (c: string) => c || null;
  const onRateLimited = () => (pace = pace ? Math.min(MAX_PACE_MS, pace * 2) : RATE_LIMITED_PACE_MS);
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) break;
    const params = new URLSearchParams({ transactionType: "Sale", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    let res: TransactionPage;
    try {
      res = await getWithRetry<TransactionPage>(client, `${base}?${params}`, { onRateLimited, signal });
    } catch (e) {
      if (signal?.aborted) break; // stopped while waiting out a rate limit: keep what's loaded
      throw e;
    }
    let reachedSince = false;
    for (const raw of res.data) {
      if (since && new Date(raw.created) < since) {
        reachedSince = true;
        break;
      }
      const t = toSaleTransaction(raw);
      if (t) transactions.push(t);
    }
    onProgress?.({ pages: page + 1, sales: transactions.length, oldest: transactions.at(-1)?.created ?? null });
    // This page has the sales just past `since`, so a longer load starts here.
    if (reachedSince) return { transactions, reachedSince, reachedEnd: false, truncated: false, resumeCursor: resume(cursor) };
    if (!res.nextPageCursor) return { transactions, reachedSince: false, reachedEnd: true, truncated: false, resumeCursor: null };
    cursor = res.nextPageCursor;
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
