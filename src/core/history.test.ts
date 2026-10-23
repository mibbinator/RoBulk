import { describe, expect, it } from "vitest";
import type { SellableItem } from "../api/types";
import { setEdits } from "./edits";
import { History, describeChanges, memoryStorage, restorePatches, snapshotOf } from "./history";

const shirt = (over: Partial<SellableItem> = {}): SellableItem => ({
  key: "avatar:1", kind: "avatar", id: 1, assetType: 11, name: "Red Shirt", price: 10, onSale: true, ...over,
});

describe("History", () => {
  it("takes at most one automatic snapshot a day", async () => {
    let now = new Date("2026-10-01T10:00:00Z");
    const h = new History(memoryStorage(), () => now);

    expect(await h.autoSnapshot("Group:1", [shirt()])).not.toBeNull();
    now = new Date("2026-10-01T20:00:00Z");
    expect(await h.autoSnapshot("Group:1", [shirt()])).toBeNull();
    now = new Date("2026-10-02T08:00:00Z");
    expect(await h.autoSnapshot("Group:1", [shirt()])).not.toBeNull();
    expect(await h.snapshots("Group:1")).toHaveLength(2);
  });

  it("keeps snapshots per creator and caps them", async () => {
    const h = new History(memoryStorage());
    for (let i = 0; i < 35; i++) await h.addSnapshot("User:1", "manual", []);
    await h.addSnapshot("Group:2", "manual", []);

    expect(await h.snapshots("User:1")).toHaveLength(30);
    expect(await h.snapshots("Group:2")).toHaveLength(1);
  });

  it("logs newest first and filters by creator", async () => {
    const h = new History(memoryStorage());
    const entry = (itemKey: string, creatorKey = "User:1") => ({ at: "", creatorKey, itemKey, itemName: itemKey, changes: {}, ok: true });
    await h.appendLog([entry("a"), entry("b")]);
    await h.appendLog([entry("c", "Group:9")]);

    expect((await h.log()).map((e) => e.itemKey)).toEqual(["c", "b", "a"]);
    expect((await h.log("User:1")).map((e) => e.itemKey)).toEqual(["b", "a"]);
    await h.clearLog("User:1");
    expect((await h.log()).map((e) => e.itemKey)).toEqual(["c"]);
  });
});

describe("restorePatches", () => {
  it("stages the snapshot's values back onto current items", async () => {
    const before = [shirt({ price: 10, onSale: true })];
    const h = new History(memoryStorage());
    const snap = await h.addSnapshot("User:1", "manual", snapshotOf(before));

    // Premium lapsed: everything went off sale.
    const now = [shirt({ price: 10, onSale: false }), shirt({ key: "avatar:2", id: 2 })];
    const edits = setEdits(new Map(), restorePatches(snap, now));

    expect([...edits.entries()]).toEqual([["avatar:1", { onSale: true }]]);
  });
});

describe("describeChanges", () => {
  it("records from and to values", () => {
    expect(describeChanges(shirt(), { price: 15, onSale: false })).toEqual({
      price: { from: 10, to: 15 },
      onSale: { from: true, to: false },
    });
  });
});
