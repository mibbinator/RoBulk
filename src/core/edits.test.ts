import { describe, expect, it } from "vitest";
import type { AvatarItem } from "../api/types";
import { applyAction, pendingChanges, setEdit } from "./edits";

const item = (assetId: number, over: Partial<AvatarItem> = {}): AvatarItem => ({
  assetId,
  assetType: 11,
  name: `Item ${assetId}`,
  collectibleItemId: `c-${assetId}`,
  price: 5,
  onSale: false,
  ...over,
});

describe("edits", () => {
  it("puts selected items on sale, keeping their current price", () => {
    const items = [item(1), item(2, { price: 10 })];
    const edits = applyAction(new Map(), items, { kind: "putOnSale" });

    expect(pendingChanges(items, edits).map((c) => c.settings)).toEqual([
      { onSale: true, price: 5 },
      { onSale: true, price: 10 },
    ]);
  });

  it("combines a price change with a sale change on the same item", () => {
    const items = [item(1)];
    let edits = applyAction(new Map(), items, { kind: "setPrice", price: 25 });
    edits = applyAction(edits, items, { kind: "putOnSale" });

    expect(edits.get(1)).toEqual({ price: 25, onSale: true });
  });

  it("drops an edit once it matches the original again", () => {
    const a = item(1);
    let edits = setEdit(new Map(), a, { price: 9 });
    edits = setEdit(edits, a, { price: 5 });

    expect(edits.size).toBe(0);
  });

  it("skips items already in the requested state", () => {
    const items = [item(1, { onSale: true }), item(2)];
    const edits = applyAction(new Map(), items, { kind: "putOnSale" });

    expect([...edits.keys()]).toEqual([2]);
  });

  it("flags changes that can't be saved", () => {
    const items = [item(1, { price: null }), item(2, { collectibleItemId: null }), item(3)];
    let edits = applyAction(new Map(), items, { kind: "putOnSale" });
    edits = setEdit(edits, items[2], { price: 4.5 });

    expect(pendingChanges(items, edits).map((c) => c.problem)).toEqual([
      "Set a price first",
      "Roblox didn't return a sale id for this item",
      "Price must be a whole number of Robux",
    ]);
  });
});
