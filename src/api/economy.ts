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

/** How many times one request waits out "too many requests" before giving up (several minutes in all). */
const RATE_LIMIT_WAITS = 8;

async function getWithRetry<T>(
  client: RobloxClient,
  url: string,
  { onRateLimited, signal }: { onRateLimited?: (waitMs: number) => void; signal?: AbortSignal } = {},
  attempts = 4,
): Promise<T> {
  let waits = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.json<T>(url);
    } catch (e) {
      if (signal?.aborted) throw e;
      // Too many requests: wait as long as Roblox asks (or longer each time), and slow down.
      if (e instanceof RobloxApiError && e.status === 429 && waits < RATE_LIMIT_WAITS) {
        const wait = e.retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** waits);
        waits++;
        onRateLimited?.(wait);
        await sleep(wait, signal);
        continue;
      }
      if (attempt >= attempts) throw e;
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
/**
 * The pause between pages for each service once Roblox has said to slow down.
 * It lasts for the page visit, so a load that tries again doesn't rush straight
 * back into the limit.
 */
const servicePace: Record<"rec" | "eco", number> = { rec: 0, eco: 0 };

export interface TransactionProgress {
  pages: number;
  sales: number;
  oldest: string | null;
  /** How far back paging has got, counting sales skipped because they're already loaded. */
  reached: string | null;
  /** Paging through sales the records service already gave, to get to older ones. */
  skipping: boolean;
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
 * One page of sales from one of Roblox's two transaction services, newest
 * first. `handoff` (with no `next`) means this service has nothing older: carry
 * on with the economy service, skipping sales from that moment on.
 */
interface SalesSource {
  name: "rec" | "eco";
  page(
    cursor: string,
    opts: { onRateLimited: (waitMs: number) => void; signal?: AbortSignal },
  ): Promise<{
    rows: { created: string; sale: SaleTransaction | null }[];
    next: string | null;
    handoff?: number;
    /** When `next` starts a new time range: the newest moment it covers. */
    nextRangeEnd?: number;
  }>;
}

const DAY_MS = 86_400_000;
/** The records service only has sales from here on (the dashboard won't let you pick an earlier date). */
export const RECORDS_START = new Date(2024, 3, 1).getTime();
/** How much of the records service is asked for at a time, like the dashboard's longest preset. */
const RECORDS_WINDOW = 90 * DAY_MS;

/** A records cursor for the time range ending at `endMs`, starting from its newest sale. */
export const recordsWindowCursor = (endMs: number, oldestMs?: number | null) =>
  `rec:W${Math.max(RECORDS_START, endMs - RECORDS_WINDOW)}-${endMs}|${oldestMs != null ? `|O${oldestMs}` : ""}`;

/** Economy rows can be timed a moment before the same sale in the records service; skip a little before. */
const HANDOFF_SLACK_MS = 5_000;

/**
 * The records service the dashboard uses. It's asked for 90 days at a time,
 * newest first, back to when it starts; its cursors are "W<start>-<end>|<page>",
 * so a load can always carry on by date even if a page cursor stops working.
 */
function recordsSource(client: RobloxClient, creator: Creator): SalesSource {
  const base = `${RECORDS}/v2/${creator.type === "Group" ? "groups" : "users"}/${creator.id}/transactions`;
  /** The oldest sale it has given (carried in cursors between loads); older ones come from the economy service. */
  let oldestSeen: number | null = null;
  return {
    name: "rec",
    async page(cursor, opts) {
      const m = /^W(\d+)-(\d+)\|([^|]*)(?:\|O(\d+))?$/.exec(cursor);
      const endMs = m ? Number(m[2]) : Date.now();
      const startMs = m ? Number(m[1]) : Math.max(RECORDS_START, endMs - RECORDS_WINDOW);
      const inner = m ? m[3] : cursor;
      if (m?.[4]) oldestSeen = Math.min(oldestSeen ?? Infinity, Number(m[4]));
      const tail = () => (oldestSeen != null ? `|O${oldestSeen}` : "");
      const params = new URLSearchParams({ limit: "100", ledgerReason: "SaleOfGood", startTimeMillis: String(startMs), endTimeMillis: String(endMs) });
      if (inner) params.set("cursor", inner);
      let res: RecordsPage;
      try {
        res = await getWithRetry<RecordsPage>(client, `${base}?${params}`, opts);
      } catch (e) {
        // A page cursor that no longer works only costs this range: start it again (sales already kept are recognised).
        if (inner && e instanceof RobloxApiError && e.status === 400) return this.page(`W${startMs}-${endMs}|${tail()}`, opts);
        throw e;
      }
      if (!Array.isArray(res.transactions)) throw new RobloxApiError("Unexpected answer from the transaction records service", 502);
      const rows = res.transactions.map((r) => ({ created: r.createdTime, sale: toSaleFromRecord(r) }));

      // If the range isn't honoured, older ranges come back with recent sales: stop
      // here and let the economy service carry on from the oldest sale seen.
      if (rows.some((r) => Date.parse(r.created) > endMs + DAY_MS)) {
        return { rows: [], next: null, handoff: (oldestSeen ?? endMs) - HANDOFF_SLACK_MS };
      }
      for (const r of rows) oldestSeen = Math.min(oldestSeen ?? Infinity, Date.parse(r.created));

      if (res.hasMore !== false && res.nextCursor) return { rows, next: `W${startMs}-${endMs}|${res.nextCursor}${tail()}` };
      // This range is done. The records service only keeps recent sales (about 40 days for a busy store), so
      // only go on to the 90 days before it if this range's sales reached back to its start, or none have
      // turned up yet. Otherwise its sales end here: the economy service carries on from the oldest one it
      // gave, so nothing in between is skipped.
      const reachedStart = oldestSeen === null || oldestSeen <= startMs + 2 * DAY_MS;
      if (startMs > RECORDS_START && reachedStart) return { rows, next: recordsWindowCursor(startMs - 1, oldestSeen).slice(4), nextRangeEnd: startMs - 1 };
      return { rows, next: null, handoff: (oldestSeen ?? endMs) - HANDOFF_SLACK_MS };
    },
  };
}

/**
 * The older economy service. Its cursors don't last between visits. A cursor
 * "S<moment>|<page>" skips sales from that moment on (the records service had them).
 */
function economySource(client: RobloxClient, creator: Creator): SalesSource {
  const base = `${ECONOMY}/v2/${creator.type === "Group" ? "groups" : "users"}/${creator.id}/transactions`;
  return {
    name: "eco",
    async page(cursor, opts) {
      const m = /^S(\d+)\|(.*)$/.exec(cursor);
      const skipFrom = m ? Number(m[1]) : null;
      const inner = m ? m[2] : cursor;
      const params = new URLSearchParams({ transactionType: "Sale", limit: "100" });
      if (inner) params.set("cursor", inner);
      const res = await getWithRetry<TransactionPage>(client, `${base}?${params}`, opts);
      const rows = res.data.map((r) => ({ created: r.created, sale: skipFrom !== null && Date.parse(r.created) >= skipFrom ? null : toSaleTransaction(r) }));
      // Keep skipping until paging gets past the moment the records service started at.
      const stillSkipping = skipFrom !== null && rows.length > 0 && Date.parse(rows.at(-1)!.created) >= skipFrom;
      const next = res.nextPageCursor ? (stillSkipping ? `S${skipFrom}|${res.nextPageCursor}` : res.nextPageCursor) : null;
      return { rows, next };
    },
  };
}

/** Creators whose sales the records service wouldn't give this page visit; the economy service is used for them instead. */
const recordsRefused = new Set<string>();
/** Forgets which creators fell back (for tests). */
export function resetSalesSources() {
  recordsRefused.clear();
  servicePace.rec = 0;
  servicePace.eco = 0;
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
    onRateLimited: reportRateLimit,
    signal,
  }: {
    maxPages?: number;
    fromCursor?: string;
    onProgress?: (p: TransactionProgress) => void;
    /** Everything so far after each page that isn't the last, so it can be saved as it arrives. */
    onPage?: (soFar: TransactionResult) => void;
    /** Awaited before each page, so a lower-priority load can wait its turn. */
    beforePage?: () => Promise<void> | void;
    /** Roblox said to slow down; paging carries on after `waitMs`. */
    onRateLimited?: (waitMs: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<TransactionResult> {
  const key = `${creator.type}:${creator.id}`;
  const tagged = /^(rec|eco):/.exec(fromCursor);
  let source =
    (tagged ? tagged[1] === "rec" : !fromCursor && !recordsRefused.has(key)) ? recordsSource(client, creator) : economySource(client, creator);
  let cursor = tagged ? fromCursor.slice(4) : fromCursor;

  const transactions: SaleTransaction[] = [];

  // "" is the newest page, which is no help as a place to carry on from.
  const resume = (c: string, name: SalesSource["name"] = source.name) => (c ? `${name}:${c}` : null);
  const onRateLimited = (waitMs: number) => {
    const pace = servicePace[source.name];
    servicePace[source.name] = pace ? Math.min(MAX_PACE_MS, pace * 2) : RATE_LIMITED_PACE_MS;
    reportRateLimit?.(waitMs);
  };
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
    const skipping = res.rows.length > 0 && res.rows.every((r) => r.sale === null) && source.name === "eco" && cursor.startsWith("S");
    onProgress?.({ pages: page + 1, sales: transactions.length, oldest: transactions.at(-1)?.created ?? null, reached: res.rows.at(-1)?.created ?? null, skipping });
    // This page has the sales just past `since`, so a longer load starts here.
    if (reachedSince) return { transactions, reachedSince, reachedEnd: false, truncated: false, resumeCursor: resume(cursor) };
    // Nothing newer than `since` is left: the next range, or what the economy service would add, is all older.
    const olderThanSince = since && ((res.nextRangeEnd !== undefined && res.nextRangeEnd < since.getTime()) || (!res.next && res.handoff !== undefined && res.handoff < since.getTime()));
    if (olderThanSince) return { transactions, reachedSince: true, reachedEnd: false, truncated: false, resumeCursor: res.next ? resume(res.next) : resume(`S${res.handoff}|`, "eco") };
    // The records service has nothing older: the economy service carries on from where it started.
    if (!res.next && res.handoff !== undefined) {
      source = economySource(client, creator);
      cursor = `S${res.handoff}|`;
      onPage?.({ transactions: [...transactions], reachedSince: false, reachedEnd: false, truncated: true, resumeCursor: resume(cursor) });
      continue;
    }
    if (!res.next) return { transactions, reachedSince: false, reachedEnd: true, truncated: false, resumeCursor: null };
    cursor = res.next;
    onPage?.({ transactions: [...transactions], reachedSince: false, reachedEnd: false, truncated: true, resumeCursor: resume(cursor) });
    if (servicePace[source.name]) await sleep(servicePace[source.name], signal);
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
