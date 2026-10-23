import { describe, expect, it } from "vitest";
import type { SaleTransaction } from "./earnings";
import type { LogEntry, Snapshot } from "./history";
import { lastPriceChange, priceImpact } from "./priceImpact";

const DAY = 86_400_000;
const now = new Date("2026-10-23T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const snapshot = (days: number, price: number): Snapshot => ({
  id: String(days),
  creatorKey: "Group:9",
  takenAt: ago(days).toISOString(),
  reason: "auto",
  items: [{ key: "avatar:1", name: "Shirt", price, onSale: true }],
});
const logged = (days: number, from: number, to: number): LogEntry => ({
  at: ago(days).toISOString(),
  creatorKey: "Group:9",
  itemKey: "avatar:1",
  itemName: "Shirt",
  changes: { price: { from, to } },
  ok: true,
});
const sale = (days: number, robux: number): SaleTransaction => ({
  id: `${days}-${robux}-${Math.random()}`,
  created: ago(days).toISOString(),
  isPending: false,
  robux,
  buyer: { id: 1, name: "b" },
  item: { id: 1, name: "Shirt", type: "Asset" },
});

describe("price vs. sales", () => {
  it("finds the last price change, preferring the exact time from RoBulk's log", () => {
    const change = lastPriceChange("avatar:1", [snapshot(20, 5), snapshot(9, 5), snapshot(8, 10)], [logged(8.5, 5, 10)]);
    expect(change).toEqual({ at: ago(8.5), from: 5, to: 10, approximate: false });
  });

  it("falls back to snapshots for changes made outside RoBulk", () => {
    const change = lastPriceChange("avatar:1", [snapshot(20, 5), snapshot(10, 8)], []);
    expect(change).toMatchObject({ from: 5, to: 8, approximate: true });
    expect(lastPriceChange("avatar:1", [snapshot(20, 5), snapshot(10, 5)], [])).toBeNull();
  });

  it("compares equal windows either side of the change", () => {
    const change = { at: ago(10), from: 5, to: 10, approximate: false };
    // Before: 4 sales at R$3 in the 10 days before. After: 2 sales at R$7.
    const sales = [sale(1, 7), sale(5, 7), sale(11, 3), sale(12, 3), sale(15, 3), sale(19, 3), sale(25, 3)];
    const impact = priceImpact("avatar:1", change, sales, now)!;
    expect(impact.before).toMatchObject({ days: 10, sales: 4, robux: 12 });
    expect(impact.after).toMatchObject({ days: 10, sales: 2, robux: 14 });
    expect(impact.needsSalesSince).toEqual(ago(20));
    expect(priceImpact("avatar:1", { ...change, at: ago(0.5) }, sales, now)).toBeNull();
  });
});
