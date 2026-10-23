import { describe, expect, it } from "vitest";
import { buildSalePayload, type MarketplaceItem } from "./avatarSale";

// A standard classic shirt, as the dashboard's item read returns it.
const shirt: MarketplaceItem = {
  saleStatus: 1,
  price: 5,
  isCollectible: true,
  collectibleItemType: 2,
  saleLocation: { saleLocationType: 1, universeIds: [] },
  collectibleDetails: { collectibleItemId: "9222638c-74e7-40d5-995b-e8ffac6deca7", quantityLimitPerUser: 0, isResellable: false },
  dynamicPriceConfiguration: { PriceOffset: 0, IsOptOutRegionalPricing: false, MinimumPrice: 5 },
};

describe("buildSalePayload", () => {
  it("reproduces the payload the Creator Dashboard sent for the test shirt", () => {
    expect(buildSalePayload(shirt, { onSale: true, price: 5 })).toEqual({
      saleLocationConfiguration: { saleLocationType: 1, places: [] },
      saleStatus: 0,
      quantityLimitPerUser: 0,
      resaleRestriction: 2,
      priceInRobux: 5,
      priceOffset: 0,
      isFree: false,
      optOutFromRegionalPricing: false,
    });
    expect(buildSalePayload(shirt, { onSale: false, price: 5 }).saleStatus).toBe(1);
  });

  it("keeps the item's custom settings instead of resetting them", () => {
    const custom: MarketplaceItem = {
      ...shirt,
      saleLocation: { saleLocationType: 4, universeIds: [111] },
      collectibleDetails: { ...shirt.collectibleDetails, quantityLimitPerUser: 2, isResellable: true },
      dynamicPriceConfiguration: { PriceOffset: 3, IsOptOutRegionalPricing: true },
      isRentalOptIn: true,
      scheduledRelease: { OnSaleTime: null, OffSaleTime: { seconds: 1800000000 } },
    };

    expect(buildSalePayload(custom, { onSale: true, price: 50 }, [999])).toEqual({
      saleLocationConfiguration: { saleLocationType: 4, places: [999] },
      saleStatus: 0,
      quantityLimitPerUser: 2,
      resaleRestriction: 1,
      priceInRobux: 50,
      priceOffset: 3,
      isFree: false,
      optOutFromRegionalPricing: true,
      isRentalOptIn: true,
      onSaleTime: undefined,
      offSaleTime: new Date(1800000000 * 1000).toISOString(),
    });
  });

  it("ignores places for sale locations that don't use them", () => {
    expect(buildSalePayload(shirt, { onSale: true, price: 5 }, [999]).saleLocationConfiguration.places).toEqual([]);
  });

  it("marks a price of 0 as free", () => {
    expect(buildSalePayload(shirt, { onSale: true, price: 0 }).isFree).toBe(true);
  });

  it("refuses limiteds, non-collectibles and items without a sale location", () => {
    expect(() => buildSalePayload({ ...shirt, collectibleItemType: 1 }, { onSale: true, price: 5 })).toThrow(/Limited/);
    expect(() => buildSalePayload({ ...shirt, isCollectible: false }, { onSale: true, price: 5 })).toThrow();
    expect(() => buildSalePayload({ ...shirt, saleLocation: { saleLocationType: 0 } }, { onSale: true, price: 5 })).toThrow(/sale location/);
  });
});
