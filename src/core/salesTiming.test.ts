import { describe, expect, it } from "vitest";
import type { SaleTransaction } from "./earnings";
import { salesTiming } from "./salesTiming";

const at = (local: Date, robux = 3): SaleTransaction => ({
  id: String(local.getTime()) + Math.random(),
  created: local.toISOString(),
  isPending: false,
  robux,
  buyer: { id: 1, name: "b" },
  item: { id: 1, name: "Shirt", type: "Asset" },
});

describe("salesTiming", () => {
  it("counts sales by local weekday (Monday first) and hour, and finds the busiest", () => {
    // 2026-10-24 is a Saturday.
    const sat3pm = new Date(2026, 9, 24, 15, 10);
    const mon9am = new Date(2026, 9, 19, 9, 0);
    const t = salesTiming([at(sat3pm), at(sat3pm, 5), at(mon9am)], new Date(2026, 9, 1), new Date(2026, 9, 31));
    expect(t.sales[5][15]).toBe(2);
    expect(t.robux[5][15]).toBe(8);
    expect(t.sales[0][9]).toBe(1);
    expect(t.max).toBe(2);
    expect(t.busiest).toEqual({ day: 5, hour: 15, sales: 2 });
  });

  it("only counts the period asked for", () => {
    const t = salesTiming([at(new Date(2026, 8, 1, 12))], new Date(2026, 9, 1), new Date(2026, 9, 31));
    expect(t.max).toBe(0);
    expect(t.busiest).toBeNull();
  });
});
