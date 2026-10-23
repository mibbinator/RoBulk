import { describe, expect, it } from "vitest";
import { toAvatarItem } from "./catalog";

describe("toAvatarItem", () => {
  it("maps an off-sale catalog result (shape from a real group search)", () => {
    expect(
      toAvatarItem({
        id: 10382779094,
        itemType: "Asset",
        assetType: 11,
        name: "Gfuel Branded Ur Bad T-Shirt",
        price: 5,
        lowestPrice: 5,
        priceStatus: "Off Sale",
        collectibleItemId: "9222638c-74e7-40d5-995b-e8ffac6deca7",
      }),
    ).toEqual({
      key: "avatar:10382779094",
      kind: "avatar",
      id: 10382779094,
      assetType: 11,
      name: "Gfuel Branded Ur Bad T-Shirt",
      description: "",
      collectibleItemId: "9222638c-74e7-40d5-995b-e8ffac6deca7",
      price: 5,
      onSale: false,
    });
  });

  it("treats items without an Off Sale status as on sale", () => {
    expect(toAvatarItem({ id: 1, itemType: "Asset", assetType: 12, name: "P", price: 10 })?.onSale).toBe(true);
  });

  it("skips bundles", () => {
    expect(toAvatarItem({ id: 1, itemType: "Bundle", name: "B" })).toBeNull();
  });
});
