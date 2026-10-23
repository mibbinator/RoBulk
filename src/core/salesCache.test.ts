import { describe, expect, it } from "vitest";
import type { SaleTransaction } from "./earnings";
import { memoryStorage, type StorageLike } from "./history";
import { memoryOverflowStore } from "./overflowStore";
import { DEFAULT_MAX_STORED_SALES as MAX_STORED_SALES, PENDING_MAX_DAYS, SalesCache, mergeFetched, mergeOlder, packSales, planFetch, unpackSales, type SalesCacheEntry } from "./salesCache";

const DAY = 86_400_000;
const now = new Date("2026-10-23T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const sale = (id: string, daysAgo: number, isPending = false): SaleTransaction => ({
  id,
  created: ago(daysAgo).toISOString(),
  isPending,
  robux: 3,
  buyer: { id: 1, name: "b" },
  item: { id: 1, name: "Shirt", type: "Asset" },
});

describe("planFetch", () => {
  it("fetches back to what's wanted when there's no cache", () => {
    expect(planFetch(null, ago(60), now)).toEqual(ago(60));
    expect(planFetch(null, null, now)).toBeNull();
  });

  it("only fetches what's new since the last refresh, with a day's overlap", () => {
    const cache: SalesCacheEntry = { sales: [sale("a", 3)], coveredFrom: ago(200).toISOString(), updatedAt: ago(2).toISOString() };
    expect(planFetch(cache, ago(60), now)).toEqual(ago(3));
  });

  it("goes back far enough to re-check sales that were still pending", () => {
    const cache: SalesCacheEntry = {
      sales: [sale("new", 1), sale("pending", 12, true), sale("released", 20)],
      coveredFrom: null,
      updatedAt: ago(1).toISOString(),
    };
    expect(planFetch(cache, null, now)).toEqual(ago(12));
  });

  it("ignores sales stuck as pending for longer than Roblox holds them", () => {
    const cache: SalesCacheEntry = { sales: [sale("stuck", PENDING_MAX_DAYS + 10, true)], coveredFrom: null, updatedAt: ago(1).toISOString() };
    expect(planFetch(cache, null, now)).toEqual(ago(2));
  });

  it("pages everything again when all-time is wanted but the cache isn't complete", () => {
    const cache: SalesCacheEntry = { sales: [sale("a", 1)], coveredFrom: ago(60).toISOString(), updatedAt: ago(1).toISOString() };
    expect(planFetch(cache, null, now)).toBeNull();
  });
});

describe("mergeFetched", () => {
  it("stores a complete history when paging reached the first sale", () => {
    const merged = mergeFetched(null, { transactions: [sale("b", 2), sale("a", 400)], reachedSince: false, reachedEnd: true }, null, now);
    expect(merged.coveredFrom).toBeNull();
    expect(merged.sales.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("replaces the refreshed window and keeps older cached sales", () => {
    const cache: SalesCacheEntry = {
      sales: [sale("recent-pending", 5, true), sale("old", 100)],
      coveredFrom: null,
      updatedAt: ago(2).toISOString(),
    };
    const stopAt = ago(5);
    const merged = mergeFetched(
      cache,
      { transactions: [sale("new", 0), { ...sale("recent-pending", 5), isPending: false }], reachedSince: true, reachedEnd: false },
      stopAt,
      now,
    );

    expect(merged.sales.map((s) => [s.id, s.isPending])).toEqual([
      ["new", false],
      ["recent-pending", false], // no longer pending
      ["old", false],
    ]);
    expect(merged.coveredFrom).toBeNull(); // still the whole history
  });

  it("records partial coverage when paging was cut short", () => {
    const merged = mergeFetched(null, { transactions: [sale("a", 1), sale("b", 90)], reachedSince: false, reachedEnd: false }, null, now);
    expect(merged.coveredFrom).toBe(ago(90).toISOString());
  });

  it("extends coverage further back when a longer range is fetched", () => {
    const cache: SalesCacheEntry = { sales: [sale("a", 1)], coveredFrom: ago(14).toISOString(), updatedAt: ago(1).toISOString() };
    const merged = mergeFetched(cache, { transactions: [sale("a", 1), sale("c", 50)], reachedSince: true, reachedEnd: false }, ago(60), now);
    expect(merged.coveredFrom).toBe(ago(60).toISOString());
    expect(merged.sales.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("keeps the cursor for paging further back from wherever coverage now ends", () => {
    const fresh = mergeFetched(null, { transactions: [sale("a", 1)], reachedSince: true, reachedEnd: false, resumeCursor: "p2" }, ago(60), now);
    expect(fresh.olderCursor).toBe("p2");

    // A refresh of the newest sales leaves the older end, and its cursor, alone.
    const cache: SalesCacheEntry = { sales: [sale("a", 1), sale("b", 50)], coveredFrom: ago(60).toISOString(), updatedAt: ago(1).toISOString(), olderCursor: "p2" };
    const refreshed = mergeFetched(cache, { transactions: [sale("new", 0)], reachedSince: true, reachedEnd: false, resumeCursor: "top" }, ago(2), now);
    expect(refreshed.olderCursor).toBe("p2");
    expect(refreshed.coveredFrom).toBe(ago(60).toISOString());

    const complete = mergeFetched(null, { transactions: [sale("a", 1)], reachedSince: false, reachedEnd: true, resumeCursor: null }, null, now);
    expect(complete.olderCursor).toBeNull();
  });

  it("drops a stale cache that doesn't line up with the new window", () => {
    const cache: SalesCacheEntry = { sales: [sale("ancient", 300)], coveredFrom: ago(400).toISOString(), updatedAt: ago(200).toISOString() };
    const merged = mergeFetched(cache, { transactions: [sale("new", 1)], reachedSince: true, reachedEnd: false }, ago(30), now);
    expect(merged.sales.map((s) => s.id)).toEqual(["new"]);
    expect(merged.coveredFrom).toBe(ago(30).toISOString());
  });
});

describe("mergeOlder", () => {
  const cache: SalesCacheEntry = { sales: [sale("a", 1), sale("b", 50)], coveredFrom: ago(60).toISOString(), updatedAt: now.toISOString(), olderCursor: "p2" };

  it("adds older sales after the cached ones, skipping repeats from the resumed page", () => {
    const merged = mergeOlder(cache, { transactions: [sale("b", 50), sale("c", 80)], reachedSince: true, reachedEnd: false, resumeCursor: "p3" }, ago(180));
    expect(merged.sales.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(merged.coveredFrom).toBe(ago(180).toISOString());
    expect(merged.olderCursor).toBe("p3");
    expect(merged.updatedAt).toBe(cache.updatedAt); // the newest end wasn't re-read
  });

  it("marks the history complete once paging reaches the first sale", () => {
    const merged = mergeOlder(cache, { transactions: [sale("c", 400)], reachedSince: false, reachedEnd: true, resumeCursor: null }, null);
    expect(merged.coveredFrom).toBeNull();
    expect(merged.olderCursor).toBeNull();
  });

  it("covers back to the oldest sale loaded when stopped early", () => {
    const merged = mergeOlder(cache, { transactions: [sale("c", 80), sale("d", 90)], reachedSince: false, reachedEnd: false, resumeCursor: "p5" }, null);
    expect(merged.coveredFrom).toBe(ago(90).toISOString());
    expect(merged.olderCursor).toBe("p5");
  });
});

describe("stored sales", () => {
  it("round-trips through the compact format, sharing item and buyer objects", () => {
    const entry: SalesCacheEntry = { sales: [sale("a", 1, true), sale("b", 2)], coveredFrom: ago(2).toISOString(), updatedAt: now.toISOString(), olderCursor: "p2" };
    const packed = packSales(entry);
    expect(packed.items).toHaveLength(1);
    expect(packed.buyers).toHaveLength(1);

    const back = unpackSales(JSON.parse(JSON.stringify(packed)));
    expect(back).toEqual(entry);
    expect(back.sales[0].item).toBe(back.sales[1].item);
  });

  it("keeps only the newest sales past the limit, and says how far back they go", () => {
    const many = Array.from({ length: MAX_STORED_SALES + 5 }, (_, i) => ({ ...sale(String(i), 0), created: new Date(now.getTime() - i * 1000).toISOString() }));
    const packed = packSales({ sales: many, coveredFrom: ago(1).toISOString(), updatedAt: now.toISOString(), olderCursor: "p9" });
    expect(packed.rows).toHaveLength(MAX_STORED_SALES);
    expect(packed.coveredFrom).toBe(many[MAX_STORED_SALES - 1].created);
    expect(packed.olderCursor).toBeNull(); // it pointed past the dropped sales
  });

  it("reads entries saved before the compact format, and clears every creator", async () => {
    const storage = memoryStorage();
    const old: SalesCacheEntry = { sales: [sale("a", 1)], coveredFrom: null, updatedAt: now.toISOString() };
    await storage.set("sales:User:1", old);
    await storage.set("log", []);
    const cache = new SalesCache(storage);
    expect(await cache.read("User:1")).toEqual(old);

    await cache.write("Group:9", old);
    expect(await cache.read("Group:9")).toEqual({ ...old, olderCursor: null });
    expect(await cache.size()).toBeGreaterThan(0);

    await cache.clear();
    expect(await cache.read("User:1")).toBeNull();
    expect(await cache.read("Group:9")).toBeNull();
    expect(await storage.get("log")).toEqual([]); // other data is left alone
  });
});

describe("storage limit and overflow", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sale(String(i), 0), created: new Date(now.getTime() - i * 1000).toISOString() }));

  it("keeps as many sales as the Options tab allows, or all of them", () => {
    expect(packSales({ sales: many(50), coveredFrom: null, updatedAt: now.toISOString() }, 20).rows).toHaveLength(20);
    expect(packSales({ sales: many(50), coveredFrom: null, updatedAt: now.toISOString() }, null).rows).toHaveLength(50);
  });

  it("saves to the overflow store when the extension's storage refuses, and reads it back", async () => {
    const storage = memoryStorage();
    let full = true;
    const picky: StorageLike = {
      ...storage,
      set: async (key, value) => {
        if (full && key.startsWith("sales:") && !(value as { inOverflow?: boolean }).inOverflow) throw new Error("QUOTA_BYTES quota exceeded");
        return storage.set(key, value);
      },
    };
    const overflow = memoryOverflowStore();
    const cache = new SalesCache(picky, { overflow, maxSales: () => null });
    const entry: SalesCacheEntry = { sales: many(3), coveredFrom: null, updatedAt: now.toISOString(), olderCursor: null };

    await cache.write("User:1", entry);
    expect(await overflow.get("User:1")).toBeDefined();
    expect((await cache.read("User:1"))!.sales.map((s) => s.id)).toEqual(["0", "1", "2"]);
    expect(await cache.size()).toBeGreaterThan(0);

    // Once the extension's storage takes it again, the overflow copy goes.
    full = false;
    await cache.write("User:1", entry);
    expect(await overflow.get("User:1")).toBeUndefined();
    expect((await cache.read("User:1"))!.sales).toHaveLength(3);

    await cache.clear();
    expect(await cache.read("User:1")).toBeNull();
  });
});
