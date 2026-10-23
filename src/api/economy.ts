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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getWithRetry<T>(client: RobloxClient, url: string, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.json<T>(url);
    } catch (e) {
      if (!(e instanceof RobloxApiError) || e.status !== 429 || attempt >= attempts) throw e;
      await sleep(e.retryAfterMs ?? 3000 * 2 ** attempt);
    }
  }
}

export interface TransactionProgress {
  pages: number;
  sales: number;
  oldest: string | null;
}

export interface TransactionResult {
  transactions: SaleTransaction[];
  /** True when the page limit cut the history short of `since`. */
  truncated: boolean;
}

/**
 * Sale transactions from newest back to `since`. Roblox only pages through
 * history, so a cap keeps very busy stores from taking minutes.
 */
export async function listSales(
  client: RobloxClient,
  creator: Creator,
  since: Date,
  { maxPages = 60, onProgress, signal }: { maxPages?: number; onProgress?: (p: TransactionProgress) => void; signal?: AbortSignal } = {},
): Promise<TransactionResult> {
  const base =
    creator.type === "Group"
      ? `${ECONOMY}/v2/groups/${creator.id}/transactions`
      : `${ECONOMY}/v2/users/${creator.id}/transactions`;
  const transactions: SaleTransaction[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) break;
    const params = new URLSearchParams({ transactionType: "Sale", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await getWithRetry<TransactionPage>(client, `${base}?${params}`);
    let reachedStart = false;
    for (const raw of res.data) {
      if (new Date(raw.created) < since) {
        reachedStart = true;
        break;
      }
      const t = toSaleTransaction(raw);
      if (t) transactions.push(t);
    }
    onProgress?.({ pages: page + 1, sales: transactions.length, oldest: transactions.at(-1)?.created ?? null });
    if (reachedStart || !res.nextPageCursor) return { transactions, truncated: false };
    cursor = res.nextPageCursor;
    await sleep(350);
  }
  return { transactions, truncated: true };
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
