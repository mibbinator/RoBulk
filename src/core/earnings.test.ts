import { describe, expect, it } from "vitest";
import type { SellableItem } from "../api/types";
import { byMonth, change, dayRange, summarize, type SaleTransaction } from "./earnings";

const sale = (over: Partial<SaleTransaction> & { day: number; hour?: number }): SaleTransaction => ({
  id: Math.random().toString(36),
  created: new Date(2026, 9, over.day, over.hour ?? 12).toISOString(),
  isPending: false,
  robux: 7,
  buyer: { id: 1, name: "alice" },
  item: { id: 101, name: "Red Shirt", type: "Asset" },
  ...over,
});

const items: SellableItem[] = [
  { key: "avatar:101", kind: "avatar", id: 101, assetType: 11, name: "Red Shirt", price: 10, onSale: true },
  { key: "avatar:202", kind: "avatar", id: 202, assetType: 12, name: "Blue Pants", price: 10, onSale: true },
];

describe("summarize", () => {
  const from = new Date(2026, 9, 1);
  const to = new Date(2026, 9, 3);

  it("totals, averages and fills every day", () => {
    const s = summarize(
      [
        sale({ day: 1 }),
        sale({ day: 1, robux: 3, isPending: true, buyer: { id: 2, name: "bob" } }),
        sale({ day: 3, item: { id: 202, name: "Blue Pants", type: "Asset" } }),
        sale({ day: 9 }), // outside the range
      ],
      from,
      to,
      items,
    );

    expect(s.totalRobux).toBe(17);
    expect(s.pendingRobux).toBe(3);
    expect(s.sales).toBe(3);
    expect(s.uniqueBuyers).toBe(2);
    expect(s.averagePerSale).toBeCloseTo(17 / 3);
    expect(s.daily.map((d) => [d.date, d.robux, d.sales])).toEqual([
      ["2026-10-01", 10, 2],
      ["2026-10-02", 0, 0],
      ["2026-10-03", 7, 1],
    ]);
  });

  it("breaks revenue down by category, item and buyer", () => {
    const s = summarize(
      [
        sale({ day: 1 }),
        sale({ day: 2 }),
        sale({ day: 2, robux: 70, item: { id: 9, name: "VIP", type: "GamePass" }, buyer: { id: 2, name: "bob" } }),
      ],
      from,
      to,
      items,
    );

    expect(s.byCategory.map((c) => [c.label, c.robux])).toEqual([
      ["Classic Shirts", 14],
      ["Game Passes", 70],
    ]);
    expect(s.topItems.map((i) => [i.key, i.robux, i.sales])).toEqual([
      ["gamePass:9", 70, 1],
      ["avatar:101", 14, 2],
    ]);
    expect(s.topBuyers[0]).toMatchObject({ label: "bob", robux: 70 });
    expect(s.perItem.get("avatar:101")?.daily.map((d) => d.sales)).toEqual([1, 1, 0]);
  });

  it("folds categories past six into one slice", () => {
    const types = [
      [2, "Asset"], [11, "Asset"], [12, "Asset"], [8, "Asset"], [64, "Asset"], [17, "Asset"], [0, "GamePass"], [0, "DeveloperProduct"],
    ] as const;
    const known: SellableItem[] = types.map(([assetType], i) => ({ key: `avatar:${i}`, kind: "avatar", id: i, assetType, name: `i${i}`, price: 1, onSale: true }));
    const txs = types.map(([, type], i) => sale({ day: 1, robux: 100 - i, item: { id: i, name: `i${i}`, type } }));

    const s = summarize(txs, from, to, known);

    expect(s.byCategory).toHaveLength(6);
    expect(s.byCategory.at(-1)).toMatchObject({ label: "Everything else" });
    expect(s.byCategory.reduce((sum, c) => sum + c.robux, 0)).toBe(s.totalRobux);
  });
});

describe("helpers", () => {
  it("lists days inclusively", () => {
    expect(dayRange(new Date(2026, 9, 30), new Date(2026, 10, 1))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("computes period-over-period change", () => {
    expect(change(150, 100)).toBe(0.5);
    expect(change(0, 0)).toBe(0);
    expect(change(5, 0)).toBeNull();
  });
});

describe("byMonth", () => {
  it("rolls days up into months", () => {
    expect(
      byMonth([
        { date: "2026-09-29", robux: 5, sales: 1 },
        { date: "2026-09-30", robux: 0, sales: 0 },
        { date: "2026-10-01", robux: 7, sales: 2 },
      ]),
    ).toEqual([
      { date: "2026-09", robux: 5, sales: 1 },
      { date: "2026-10", robux: 7, sales: 2 },
    ]);
  });
});
