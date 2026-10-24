import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBeforeTimeRanges, repairHandoff } from "../core/salesCache";
import { RECORDS_START, listSales, resetSalesSources, toSaleFromRecord, type RawRecord } from "./economy";
import { createClient } from "./http";
import type { Creator } from "./types";

const group: Creator = { type: "Group", id: 4861395, name: "[Valor Designs]", access: { avatarItems: true, experiences: true, earnings: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// Two sales as the transaction records service returned them for a real group.
const shirtSale: RawRecord = {
  counterParty: { type: "User", id: "630693500" },
  ledgerReason: "SaleOfGood",
  holdStatus: "Active",
  amount: "2",
  details: {
    productId: 3253141890,
    productName: "Orange Suit [+]",
    productTypeId: 8,
    productTargetId: 20438511095416,
    assetId: 113366284518352,
    collectibleItemTargetId: "113366284518352",
  },
  createdTime: "2026-10-23T23:38:05.276Z",
};
const pantsSale: RawRecord = {
  counterParty: { type: "User", id: "1555290461" },
  ledgerReason: "SaleOfGood",
  holdStatus: "Settled",
  amount: "2",
  details: { productId: 3253142004, productName: "Orange Suit [-]", productTypeId: 8, productTargetId: 6140492060235229, assetId: 130151319754295 },
  createdTime: "2026-10-23T22:55:11.097Z",
};
const sold = (record: RawRecord, created: string): RawRecord => ({ ...record, createdTime: created });

/**
 * A pretend records service that honours time ranges like the real one should:
 * `sales` (newest first) are split into pages of `perPage` within each range.
 */
function recordsService(sales: RawRecord[], perPage = 2) {
  return (url: string) => {
    const q = new URL(url).searchParams;
    const from = Number(q.get("startTimeMillis"));
    const to = Number(q.get("endTimeMillis"));
    const inRange = sales.filter((r) => Date.parse(r.createdTime) >= from && Date.parse(r.createdTime) <= to);
    const page = Number((q.get("cursor") ?? "p0").slice(1));
    const rows = inRange.slice(page * perPage, (page + 1) * perPage);
    const more = (page + 1) * perPage < inRange.length;
    return json({ transactions: rows, nextCursor: more ? `p${page + 1}` : null, hasMore: more });
  };
}

afterEach(() => resetSalesSources());

describe("transaction records", () => {
  it("reads a sale: the item, what the group got, and whether Roblox still holds it", () => {
    expect(toSaleFromRecord(shirtSale)).toEqual({
      id: "rec:2026-10-23T23:38:05.276Z:630693500:3253141890",
      created: "2026-10-23T23:38:05.276Z",
      isPending: true, // "Active" hold: not paid out yet
      robux: 2,
      buyer: { id: 630693500, name: "" },
      item: { id: 113366284518352, name: "Orange Suit [+]", type: "Asset" },
    });
    expect(toSaleFromRecord(pantsSale)!.isPending).toBe(false);
  });

  it("reads game passes and developer products with the experience they belong to, and skips refunds", () => {
    const pass = toSaleFromRecord({ ...shirtSale, details: { productId: 9, productName: "VIP", productTypeId: 6, productTargetId: 777, productUniverseId: "42" } });
    expect(pass!.item).toEqual({ id: 777, name: "VIP", type: "GamePass", universeId: 42 });
    const product = toSaleFromRecord({ ...shirtSale, details: { productId: 10, productName: "Coins", productTypeId: 4, productTargetId: 555, productUniverseId: 42 } });
    expect(product!.item).toEqual({ id: 555, name: "Coins", type: "DeveloperProduct", universeId: 42 });
    expect(toSaleFromRecord({ ...shirtSale, holdStatus: "Cancelled" })).toBeNull();
    expect(toSaleFromRecord({ ...shirtSale, amount: "-2" })).toBeNull();
  });

  it("goes back 90 days at a time while each range is full, then hands over to the economy service", async () => {
    // Sales reach the start of the first two ranges (90 and 180 days back); then the records service has no more.
    const records = [sold(shirtSale, daysAgo(0.1)), sold(pantsSale, daysAgo(89)), sold(pantsSale, daysAgo(100)), sold(pantsSale, daysAgo(179))];
    const service = recordsService(records);
    const eco = (id: string, created: string) => ({ idHash: id, created, agent: { id: 9, type: "User", name: "b" }, details: { id: 1, name: id, type: "Asset" }, currency: { amount: 3, type: "Robux" } });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("transaction-records-api")) return service(url);
      // The economy service lists every sale, newest first (timed a second before the records service's).
      const early = (d: number) => new Date(Date.parse(daysAgo(d)) - 1000).toISOString();
      return json({ data: [eco("dup-0", early(0.1)), eco("dup-89", early(89)), eco("dup-179", early(179)), eco("Old shirt", daysAgo(400))], nextPageCursor: null });
    });

    const res = await listSales(createClient(fetchImpl), group, null, { maxPages: 100 });

    const ranges = fetchImpl.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("transaction-records-api")).map((u) => new URL(u).searchParams);
    expect(ranges[0].get("ledgerReason")).toBe("SaleOfGood");
    expect(Number(ranges[0].get("endTimeMillis")) - Number(ranges[0].get("startTimeMillis"))).toBe(90 * DAY);
    expect(ranges).toHaveLength(3); // the third range came back empty, so the records service's sales end there
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toContain("economy.roblox.com");
    expect(res.transactions.map((t) => t.item.name)).toEqual(["Orange Suit [+]", "Orange Suit [-]", "Orange Suit [-]", "Orange Suit [-]", "Old shirt"]);
    expect(res.reachedEnd).toBe(true);
  });

  it("saves cursors with their time range, so a later visit carries on by date", async () => {
    const records = [sold(shirtSale, daysAgo(1)), sold(shirtSale, daysAgo(2)), sold(pantsSale, daysAgo(3))];
    const fetchImpl = vi.fn(async (url: string) => recordsService(records)(url));
    const pages: (string | null)[] = [];
    await listSales(createClient(fetchImpl), group, new Date(Date.now() - 2.5 * DAY), { onPage: (p) => pages.push(p.resumeCursor) });
    expect(pages[0]).toMatch(/^rec:W\d+-\d+\|p1\|O\d+$/); // the range, the page, and the oldest sale seen

    const later = vi.fn(async (url: string) => recordsService(records)(url));
    await listSales(createClient(later), group, null, { fromCursor: pages[0]!, maxPages: 1 });
    const q = new URL(String(later.mock.calls[0][0])).searchParams;
    expect(q.get("cursor")).toBe("p1");
    expect(pages[0]).toContain(`rec:W${q.get("startTimeMillis")}-${q.get("endTimeMillis")}|p1|`);
  });

  it("starts just the range again if a page cursor is rejected", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("cursor=stale")) return json({ errors: [{ code: 4, message: "Invalid cursor" }] }, 400);
      return json({ transactions: [pantsSale], nextCursor: null, hasMore: false });
    });
    await listSales(createClient(fetchImpl), group, null, { fromCursor: "rec:W1000-2000|stale", maxPages: 1 });
    const retry = new URL(String(fetchImpl.mock.calls[1][0])).searchParams;
    expect([retry.get("startTimeMillis"), retry.get("endTimeMillis"), retry.get("cursor")]).toEqual(["1000", "2000", null]);
  });

  it("hands over to the economy service if the records service ignores time ranges", async () => {
    // Whatever range is asked for, recent sales come back.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("transaction-records-api")) return json({ transactions: [sold(shirtSale, daysAgo(1))], nextCursor: null, hasMore: false });
      return json({ data: [], nextPageCursor: null });
    });
    const res = await listSales(createClient(fetchImpl), group, null, { maxPages: 10 });
    expect(res.transactions).toHaveLength(1); // the recent sale once, not again from the second range
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toContain("economy.roblox.com");
  });

  it("falls back to the economy service when the records service refuses", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("transaction-records-api")) return json({ errors: [{ code: 3, message: "Insufficient permissions." }] }, 403);
      return json({ data: [{ idHash: "x", created: "2026-10-22T00:00:00Z", agent: { id: 9, type: "User", name: "b" }, details: { id: 1, name: "Shirt", type: "Asset" }, currency: { amount: 3, type: "Robux" } }], nextPageCursor: null });
    });
    const res = await listSales(createClient(fetchImpl), group, null);
    expect(res.transactions).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("economy.roblox.com");
    await listSales(createClient(fetchImpl), group, null);
    expect(String(fetchImpl.mock.calls[2][0])).toContain("economy.roblox.com");
  });

  it("uses the economy service for a cursor saved before the switch", async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ data: [], nextPageCursor: null }));
    await listSales(createClient(fetchImpl), group, null, { fromCursor: "old-economy-cursor" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("economy.roblox.com");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("cursor=old-economy-cursor");
  });
});

describe("histories saved before time ranges", () => {
  const sale = (id: string, created: string) => ({ id, created, isPending: false, robux: 2, buyer: { id: 1, name: "" }, item: { id: 1, name: "Shirt", type: "Asset" } });

  it("carries on by date when the records service's recent window was taken as the whole history", () => {
    const entry = fromBeforeTimeRanges({ sales: [sale("rec:a", daysAgo(1)), sale("rec:b", daysAgo(95))], coveredFrom: null, updatedAt: daysAgo(0), olderCursor: null });
    expect(entry.coveredFrom).toBe(entry.sales[1].created);
    expect(entry.olderCursor).toMatch(/^rec:W\d+-\d+\|\|O\d+$/);
    expect(Number(/-(\d+)\|/.exec(entry.olderCursor!)![1])).toBe(Date.parse(entry.sales[1].created));
    expect(Number(/\|O(\d+)$/.exec(entry.olderCursor!)![1])).toBe(Date.parse(entry.sales[1].created));
  });

  it("leaves histories from the economy service alone", () => {
    const entry = { sales: [sale("rec:a", daysAgo(1)), sale("eco-old", "2022-01-01T00:00:00Z")], coveredFrom: null, updatedAt: daysAgo(0), olderCursor: null };
    expect(fromBeforeTimeRanges(entry)).toBe(entry);
  });
});

describe("carrying on between visits", () => {
  it("continues a stopped history from the saved cursor on the next visit, not from the newest sale", async () => {
    const { SalesCache } = await import("../core/salesCache");
    const { memoryStorage } = await import("../core/history");
    const { salesLoader, forgetSalesLoaders } = await import("../ui/salesLoader");
    const records = [sold(shirtSale, daysAgo(1)), sold(pantsSale, daysAgo(2)), sold(pantsSale, daysAgo(3))];
    const service = recordsService(records);
    const requested: string[] = [];
    let visit = 1;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/currency")) return json({ robux: 1 });
      if (url.includes("economy.roblox.com")) return json({ data: [], nextPageCursor: null });
      const q = new URL(url).searchParams;
      const window = Date.now() - Number(q.get("startTimeMillis")) <= 91 * DAY ? "now" : "older";
      requested.push(`${visit}:${window}:${q.get("cursor") ?? ""}`);
      // On the first visit page 2 never arrives: the tab is closed while it loads.
      if (visit === 1 && q.get("cursor")) return new Promise<Response>(() => {});
      return service(url);
    });
    const storage = memoryStorage();

    const first = salesLoader(group, createClient(fetchImpl), new SalesCache(storage), () => true);
    first.load(null);
    await vi.waitFor(() => expect(first.state.entry?.olderCursor).toMatch(/^rec:W\d+-\d+\|p1\|O\d+$/));
    first.stop();
    await first.flushed();
    forgetSalesLoaders();

    visit = 2;
    const again = salesLoader(group, createClient(fetchImpl), new SalesCache(storage), () => true);
    again.load(null);
    await vi.waitFor(() => expect(again.state.loading).toBe(true));
    await again.whenDone();
    // Visit 2 checks what's new, then carries on from page 2 of the same range, then the older ranges.
    expect(requested.slice(0, 4)).toEqual(["1:now:", "1:now:p1", "2:now:", "2:now:p1"]);
    expect(requested.filter((r) => r === "2:now:")).toHaveLength(1);
    expect(again.state.entry!.sales).toHaveLength(3);
    expect(again.state.entry!.coveredFrom).toBeNull();
  });
});

describe("when the records service only keeps recent sales", () => {
  it("hands over at the oldest sale it gave, so nothing older is skipped and nothing is counted twice", async () => {
    // The records service has the last 30 days only; the economy service has everything.
    const records = [sold(shirtSale, daysAgo(1)), sold(pantsSale, daysAgo(30))];
    const service = recordsService(records);
    const eco = (id: string, created: string) => ({ idHash: id, created, agent: { id: 9, type: "User", name: "b" }, details: { id: 1, name: `Sale ${id}`, type: "Asset" }, currency: { amount: 2, type: "Robux" } });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("transaction-records-api")) return service(url);
      return json({
        data: [
          eco("same-as-1", daysAgo(1)),
          // The same sale as the records service's oldest, timed a second earlier.
          eco("same-as-30", new Date(Date.parse(daysAgo(30)) - 1000).toISOString()),
          eco("200-days", daysAgo(200)),
          eco("700-days", daysAgo(700)),
        ],
        nextPageCursor: null,
      });
    });
    const res = await listSales(createClient(fetchImpl), group, null, { maxPages: 100 });
    expect(res.transactions.map((t) => t.item.name)).toEqual(["Orange Suit [+]", "Orange Suit [-]", "Sale 200-days", "Sale 700-days"]);
  });

  it("repairs a saved hand-off that skipped everything since the records service's start date", () => {
    const sale = (id: string, created: string) => ({ id, created, isPending: false, robux: 2, buyer: { id: 1, name: "" }, item: { id: 1, name: "Shirt", type: "Asset" } });
    const entry = { sales: [sale("rec:a", daysAgo(1)), sale("rec:b", daysAgo(40))], coveredFrom: daysAgo(40), updatedAt: daysAgo(0), olderCursor: `eco:S${RECORDS_START}|deep-into-skipped-pages` };
    const fixed = repairHandoff(entry);
    expect(fixed.olderCursor).toBe(`eco:S${Date.parse(entry.sales[1].created) - 5000}|`);
    // A hand-off already at the right place is left alone.
    expect(repairHandoff(fixed)).toBe(fixed);
  });
});

describe("rate limits", () => {
  it("waits as long as Roblox asks, says so, and carries on", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ errors: [{ message: "Too many requests" }] }), { status: 429, headers: { "retry-after": "1" } });
      if (String(_url).includes("economy.roblox.com")) return json({ data: [], nextPageCursor: null });
      return json({ transactions: [shirtSale], nextCursor: null, hasMore: false });
    });
    const waits: number[] = [];
    const res = await listSales(createClient(fetchImpl), group, new Date(Date.now() - 30 * DAY), { onRateLimited: (ms) => waits.push(ms) });
    expect(waits).toEqual([1000]);
    expect(res.transactions).toHaveLength(1);
  }, 10000);
});
