import { describe, expect, it } from "vitest";
import type { SaleTransaction } from "./earnings";
import { REFRESH_DAYS, mergeFetched, planFetch, type SalesCacheEntry } from "./salesCache";

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

  it("only refreshes recent sales when the cache already covers the range", () => {
    const cache: SalesCacheEntry = { sales: [sale("a", 1)], coveredFrom: ago(200).toISOString(), updatedAt: ago(1).toISOString() };
    expect(planFetch(cache, ago(60), now)).toEqual(ago(REFRESH_DAYS));
  });

  it("refreshes back to the newest cached sale if that's older", () => {
    const cache: SalesCacheEntry = { sales: [sale("a", 50)], coveredFrom: null, updatedAt: ago(50).toISOString() };
    expect(planFetch(cache, null, now)).toEqual(ago(50));
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
    const stopAt = ago(REFRESH_DAYS);
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

  it("drops a stale cache that doesn't line up with the new window", () => {
    const cache: SalesCacheEntry = { sales: [sale("ancient", 300)], coveredFrom: ago(400).toISOString(), updatedAt: ago(200).toISOString() };
    const merged = mergeFetched(cache, { transactions: [sale("new", 1)], reachedSince: true, reachedEnd: false }, ago(30), now);
    expect(merged.sales.map((s) => s.id)).toEqual(["new"]);
    expect(merged.coveredFrom).toBe(ago(30).toISOString());
  });
});
