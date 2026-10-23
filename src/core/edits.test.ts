import { describe, expect, it } from "vitest";
import type { SellableItem } from "../api/types";
import { applyAction, pendingChanges, setEdit } from "./edits";

const avatar = (id: number, over: Partial<SellableItem> = {}): SellableItem => ({
  key: `avatar:${id}`,
  kind: "avatar",
  id,
  assetType: 11,
  name: `Item ${id}`,
  collectibleItemId: `c-${id}`,
  price: 5,
  onSale: false,
  ...over,
});

const pass = (id: number, over: Partial<SellableItem> = {}): SellableItem => ({
  key: `gamePass:${id}`,
  kind: "gamePass",
  id,
  universeId: 1,
  name: `Pass ${id}`,
  price: 100,
  onSale: true,
  managedPricing: false,
  ...over,
});

describe("edits", () => {
  it("puts selected items on sale, keeping their current price", () => {
    const items = [avatar(1), avatar(2, { price: 10 })];
    const edits = applyAction(new Map(), items, { kind: "putOnSale" });

    expect(pendingChanges(items, edits).map((c) => c.settings)).toEqual([
      { onSale: true, price: 5 },
      { onSale: true, price: 10 },
    ]);
  });

  it("combines a price change with a sale change on the same item", () => {
    const items = [avatar(1)];
    let edits = applyAction(new Map(), items, { kind: "setPrice", price: 25 });
    edits = applyAction(edits, items, { kind: "putOnSale" });

    expect(edits.get("avatar:1")).toEqual({ price: 25, onSale: true });
  });

  it("drops an edit once it matches the original again", () => {
    const a = avatar(1);
    let edits = setEdit(new Map(), a, { price: 9 });
    edits = setEdit(edits, a, { price: 5 });

    expect(edits.size).toBe(0);
  });

  it("skips items already in the requested state", () => {
    const items = [avatar(1, { onSale: true }), avatar(2)];
    const edits = applyAction(new Map(), items, { kind: "putOnSale" });

    expect([...edits.keys()]).toEqual(["avatar:2"]);
  });

  it("keeps ids from different kinds apart", () => {
    const items = [avatar(1), pass(1, { onSale: false })];
    const edits = applyAction(new Map(), items, { kind: "putOnSale" });

    expect([...edits.keys()]).toEqual(["avatar:1", "gamePass:1"]);
  });

  it("only applies managed pricing to passes and products", () => {
    const items = [avatar(1), pass(2)];
    const edits = applyAction(new Map(), items, { kind: "setManagedPricing", enabled: true });

    expect([...edits.entries()]).toEqual([["gamePass:2", { managedPricing: true }]]);
  });

  it("records only the changed fields for passes", () => {
    const items = [pass(1)];
    const edits = applyAction(new Map(), items, { kind: "setPrice", price: 250 });

    expect(pendingChanges(items, edits)[0]).toMatchObject({ changed: { price: 250 }, problem: undefined });
  });

  it("flags changes that can't be saved", () => {
    const items = [avatar(1, { price: null }), pass(2, { price: null, onSale: false }), avatar(3)];
    let edits = applyAction(new Map(), items.slice(0, 2), { kind: "putOnSale" });
    edits = setEdit(edits, items[2], { price: 4.5 });

    expect(pendingChanges(items, edits).map((c) => c.problem)).toEqual([
      "Set a price first",
      "Set a price first",
      "Price must be a whole number of Robux",
    ]);
  });

  it("lets passes change managed pricing without a price", () => {
    const items = [pass(1, { price: null })];
    const edits = applyAction(new Map(), items, { kind: "setManagedPricing", enabled: true });

    expect(pendingChanges(items, edits)[0].problem).toBeUndefined();
  });
});
