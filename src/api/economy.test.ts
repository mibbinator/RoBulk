import { describe, expect, it, vi } from "vitest";
import { RATE_LIMITED_PACE_MS, listSales, toSaleTransaction } from "./economy";
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

    const { transactions, truncated, resumeCursor } = await listSales(createClient(fetchImpl), group, new Date("2026-10-15T00:00:00Z"));

    expect(transactions.map((t) => t.created.slice(0, 10))).toEqual(["2026-10-22", "2026-10-21", "2026-10-20"]);
    expect(truncated).toBe(false);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://economy.roblox.com/v2/groups/5/transactions?transactionType=Sale&limit=100");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("cursor=p2");
    // Going further back later starts on the page that crossed the start date.
    expect(resumeCursor).toBe("p2");
  });

  it("carries on from a cursor, and says where to carry on from when cut short", async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify({ data: [raw("2026-09-01T00:00:00Z")], nextPageCursor: "p6" })));

    const res = await listSales(createClient(fetchImpl), group, null, { fromCursor: "p5", maxPages: 1 });

    expect(String(fetchImpl.mock.calls[0][0])).toContain("cursor=p5");
    expect(res.truncated).toBe(true);
    expect(res.resumeCursor).toBe("p6");
  });

  it("fetches pages back to back until Roblox rate-limits, then paces itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const page = (day: number, next: string | null) => ({ data: [raw(`2026-10-${day}T00:00:00Z`)], nextPageCursor: next });
      const responses = [
        () => new Response(JSON.stringify(page(22, "p2"))),
        () => new Response(JSON.stringify(page(21, "p3"))),
        () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
        () => new Response(JSON.stringify(page(20, "p4"))),
        () => new Response(JSON.stringify(page(19, null))),
      ];
      const at: number[] = [];
      const fetchImpl = vi.fn(async (_url: string) => {
        at.push(Date.now());
        return responses.shift()!();
      });

      const result = listSales(createClient(fetchImpl), group, null);
      await vi.runAllTimersAsync();
      const { transactions, reachedEnd } = await result;

      expect(transactions).toHaveLength(4);
      expect(reachedEnd).toBe(true);
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      expect(gaps).toEqual([0, 0, 2000, RATE_LIMITED_PACE_MS]); // no pause, Retry-After, then paced
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries again after a Roblox server error instead of giving up", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ errors: [{ message: "Service unavailable" }] }), { status: 503 });
      return new Response(JSON.stringify({ data: [raw("2026-10-22T00:00:00Z")], nextPageCursor: null }));
    });
    const res = await listSales(createClient(fetchImpl), group, null);
    expect(calls).toBe(2);
    expect(res.transactions).toHaveLength(1);
    expect(res.reachedEnd).toBe(true);
  }, 10000);

  it("stops while waiting out a rate limit and keeps what was loaded", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string) => {
      if (fetchImpl.mock.calls.length === 1) return new Response(JSON.stringify({ data: [raw("2026-10-22T00:00:00Z")], nextPageCursor: "p2" }));
      setTimeout(() => controller.abort(), 0);
      return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    });

    const { transactions, truncated } = await listSales(createClient(fetchImpl), group, null, { signal: controller.signal });

    expect(transactions).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});
