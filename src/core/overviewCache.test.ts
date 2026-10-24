import { describe, expect, it } from "vitest";
import { memoryStorage } from "./history";
import { clearOverview, readOverview, writeOverview, type OverviewRow } from "./overviewCache";

const row: OverviewRow = {
  creator: { type: "Group", id: 9, name: "Test Group", access: { avatarItems: true, experiences: true, earnings: true }, owned: true },
  owned: true,
  percent: 100,
  periods: { 7: { cur: 10, prev: 5, pending: 2 }, 30: { cur: 40, prev: 30, pending: 2 }, 90: { cur: 100, prev: 80, pending: 2 } },
  all: null,
  recentDone: true,
  balance: 250,
  asOf: "2026-10-20T12:00:00.000Z",
};

describe("saved account overview", () => {
  it("keeps the last report until it's cleared", async () => {
    const storage = memoryStorage();
    expect(await readOverview(storage)).toBeNull();
    await writeOverview(storage, [row]);
    expect((await readOverview(storage))?.rows).toEqual([row]);
    await clearOverview(storage);
    expect(await readOverview(storage)).toBeNull();
  });

  it("ignores a saved report in a shape it doesn't know", async () => {
    const storage = memoryStorage();
    await storage.set("overview", { v: 99, rows: [row] });
    expect(await readOverview(storage)).toBeNull();
  });
});
