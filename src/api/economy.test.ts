import { describe, expect, it, vi } from "vitest";
import { listSales, toSaleTransaction } from "./economy";
import { createClient } from "./http";
import type { Creator } from "./types";

const raw = (created: string, amount = 7) => ({
  id: 1,
  idHash: `h-${created}`,
  created,
  isPending: false,
  agent: { id: 9, type: "User", name: "buyer" },
  details: { id: 101, name: "Red Shirt", type: "Asset" },
  currency: { amount, type: "Robux" },
});

const group: Creator = { type: "Group", id: 5, name: "Store", access: { avatarItems: true, experiences: true, earnings: true } };

describe("economy", () => {
  it("parses a sale transaction", () => {
    expect(toSaleTransaction(raw("2026-10-20T10:00:00Z"))).toEqual({
      id: "h-2026-10-20T10:00:00Z",
      created: "2026-10-20T10:00:00Z",
      isPending: false,
      robux: 7,
      buyer: { id: 9, name: "buyer" },
      item: { id: 101, name: "Red Shirt", type: "Asset" },
    });
    expect(toSaleTransaction({ created: "x" })).toBeNull();
  });

  it("pages back until it passes the start date", async () => {
    const pages = [
      { data: [raw("2026-10-22T00:00:00Z"), raw("2026-10-21T00:00:00Z")], nextPageCursor: "p2" },
      { data: [raw("2026-10-20T00:00:00Z"), raw("2026-10-01T00:00:00Z")], nextPageCursor: "p3" },
    ];
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify(pages.shift())));

    const { transactions, truncated } = await listSales(createClient(fetchImpl), group, new Date("2026-10-15T00:00:00Z"));

    expect(transactions.map((t) => t.created.slice(0, 10))).toEqual(["2026-10-22", "2026-10-21", "2026-10-20"]);
    expect(truncated).toBe(false);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://economy.roblox.com/v2/groups/5/transactions?transactionType=Sale&limit=100");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("cursor=p2");
  });
});
