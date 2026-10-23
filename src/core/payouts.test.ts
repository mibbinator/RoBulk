import { describe, expect, it } from "vitest";
import type { SaleTransaction } from "./earnings";
import { memoryStorage } from "./history";
import { markPaid, owed, readPlan, writePlan, type Designer } from "./payouts";

const sale = (id: string, itemId: number, robux: number, created: string): SaleTransaction => ({
  id,
  created,
  isPending: false,
  robux,
  buyer: { id: 1, name: "b" },
  item: { id: itemId, name: "Shirt", type: "Asset" },
});

const designer: Designer = { userId: 7, name: "maker", share: 25, itemKeys: ["avatar:1", "avatar:2"], paidThrough: null };
const sales = [
  sale("a", 1, 30, "2026-10-20T00:00:00Z"),
  sale("b", 2, 10, "2026-10-10T00:00:00Z"),
  sale("c", 3, 99, "2026-10-10T00:00:00Z"), // someone else's item
  sale("d", 1, 50, "2026-09-01T00:00:00Z"), // before the period
];

describe("payouts", () => {
  it("gives a designer their share of what their items earned in the period, rounded down", () => {
    const result = owed(designer, sales, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-23T00:00:00Z"));
    expect(result).toEqual({ sales: 2, earned: 40, amount: 10 });
    expect(owed({ ...designer, share: 33 }, sales, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-23T00:00:00Z")).amount).toBe(13); // 13.2
  });

  it("starts the next period where the last payout ended, so nothing is paid twice", async () => {
    const storage = memoryStorage();
    const to = new Date("2026-10-15T00:00:00Z");
    const plan = markPaid({ designers: [designer], paid: [] }, [{ designer, amount: 2, from: new Date("2026-10-01T00:00:00Z") }], to);
    await writePlan(storage, "Group:9", plan);

    const saved = await readPlan(storage, "Group:9");
    expect(saved.designers[0].paidThrough).toBe(to.toISOString());
    expect(saved.paid[0]).toMatchObject({ userId: 7, amount: 2 });
    // Only the sale after the 15th counts now.
    expect(owed(saved.designers[0], sales, new Date(saved.designers[0].paidThrough!), new Date("2026-10-23T00:00:00Z"))).toEqual({ sales: 1, earned: 30, amount: 7 });
  });
});
