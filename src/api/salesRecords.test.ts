import { afterEach, describe, expect, it, vi } from "vitest";
import { listSales, resetSalesSources, toSaleFromRecord, type RawRecord } from "./economy";
import { createClient } from "./http";
import type { Creator } from "./types";

const group: Creator = { type: "Group", id: 4861395, name: "[Valor Designs]", access: { avatarItems: true, experiences: true, earnings: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

  it("pages through the records service, with cursors that say where they came from", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("cursor=id_page2")) return json({ transactions: [pantsSale], nextCursor: null, hasMore: false });
      return json({ transactions: [shirtSale], nextCursor: "id_page2", hasMore: true });
    });
    const pages: (string | null)[] = [];
    const res = await listSales(createClient(fetchImpl), group, null, { onPage: (p) => pages.push(p.resumeCursor) });

    const first = String(fetchImpl.mock.calls[0][0]);
    expect(first).toContain("https://apis.roblox.com/transaction-records-api/v2/groups/4861395/transactions?");
    expect(first).toContain("ledgerReason=SaleOfGood");
    expect(first).toContain("limit=100");
    expect(res.transactions.map((t) => t.item.name)).toEqual(["Orange Suit [+]", "Orange Suit [-]"]);
    expect(res.reachedEnd).toBe(true);
    expect(pages).toEqual(["rec:id_page2"]);
  });

  it("carries on from a saved records cursor on a later visit", async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ transactions: [pantsSale], nextCursor: null, hasMore: false }));
    await listSales(createClient(fetchImpl), group, null, { fromCursor: "rec:id_page2" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("transaction-records-api");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("cursor=id_page2");
  });

  it("falls back to the economy service when the records service refuses", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("transaction-records-api")) return json({ errors: [{ code: 3, message: "Insufficient permissions." }] }, 403);
      return json({ data: [{ idHash: "x", created: "2026-10-22T00:00:00Z", agent: { id: 9, type: "User", name: "b" }, details: { id: 1, name: "Shirt", type: "Asset" }, currency: { amount: 3, type: "Robux" } }], nextPageCursor: null });
    });
    const res = await listSales(createClient(fetchImpl), group, null);
    expect(res.transactions).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("economy.roblox.com");

    // The rest of the visit goes straight to the economy service.
    await listSales(createClient(fetchImpl), group, null);
    expect(String(fetchImpl.mock.calls[2][0])).toContain("economy.roblox.com");
  });

  it("uses the economy service for a cursor saved before the switch", async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ data: [], nextPageCursor: null }));
    await listSales(createClient(fetchImpl), group, null, { fromCursor: "old-economy-cursor" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("economy.roblox.com");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("cursor=old-economy-cursor");
  });

  it("asks again with a time range if the records service says one is missing", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes("startTimeMillis")) return json({ errors: [{ code: 10, message: "Missing Request Parameter" }] }, 400);
      return json({ transactions: [shirtSale], nextCursor: null, hasMore: false });
    });
    const res = await listSales(createClient(fetchImpl), group, null);
    expect(res.transactions).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[1][0])).toMatch(/startTimeMillis=0&endTimeMillis=\d+/);
  });
});

describe("carrying on between visits", () => {
  it("continues a stopped history from the saved records cursor on the next visit, not from the newest sale", async () => {
    const { SalesCache } = await import("../core/salesCache");
    const { memoryStorage } = await import("../core/history");
    const { salesLoader, forgetSalesLoaders } = await import("../ui/salesLoader");
    const older: RawRecord = { ...pantsSale, createdTime: "2025-03-01T10:00:00.000Z" };
    const requested: string[] = [];
    let visit = 1;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/currency")) return json({ robux: 1 });
      const cursor = new URL(url).searchParams.get("cursor") ?? "";
      requested.push(`${visit}:${cursor}`);
      if (!cursor) return json({ transactions: [shirtSale], nextCursor: "id_page2", hasMore: true });
      // On the first visit page 2 never arrives: the tab is closed while it loads.
      if (visit === 1) return new Promise<Response>(() => {});
      return json({ transactions: [older], nextCursor: null, hasMore: false });
    });
    const storage = memoryStorage();

    // First visit: one page arrives, then the tab is closed.
    const first = salesLoader(group, createClient(fetchImpl), new SalesCache(storage), () => true);
    first.load(null);
    await vi.waitFor(() => expect(first.state.entry?.olderCursor).toBe("rec:id_page2"));
    first.stop();
    await first.flushed();
    forgetSalesLoaders();

    // Next visit: what's new is checked, then loading carries on from page 2.
    visit = 2;
    const again = salesLoader(group, createClient(fetchImpl), new SalesCache(storage), () => true);
    again.load(null);
    await vi.waitFor(() => expect(again.state.loading).toBe(true));
    await again.whenDone();
    // Visit 2 checks what's new (with only two pages, that check reaches page 2 too), then
    // carries on from the cursor saved on visit 1, which the records service still accepts.
    expect(requested).toEqual(["1:", "1:id_page2", "2:", "2:id_page2", "2:id_page2"]);
    expect(again.state.entry!.sales.map((s) => s.item.name)).toEqual(["Orange Suit [+]", "Orange Suit [-]"]);
    expect(again.state.entry!.coveredFrom).toBeNull();
  });
});
