import { describe, expect, it } from "vitest";
import { toAvatarItem } from "./catalog";
import { buildSalePayload } from "./collectibles";

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
      assetId: 10382779094,
      assetType: 11,
      name: "Gfuel Branded Ur Bad T-Shirt",
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

describe("buildSalePayload", () => {
  it("matches what the Creator Dashboard sends to put an item on sale", () => {
    expect(buildSalePayload({ onSale: true, price: 5 })).toEqual({
      saleLocationConfiguration: { saleLocationType: 1, places: [] },
      saleStatus: 0,
      quantityLimitPerUser: 0,
      resaleRestriction: 2,
      priceInRobux: 5,
      priceOffset: 0,
      isFree: false,
      optOutFromRegionalPricing: false,
    });
  });

  it("uses saleStatus 1 for off sale", () => {
    expect(buildSalePayload({ onSale: false, price: 5 }).saleStatus).toBe(1);
  });
});
