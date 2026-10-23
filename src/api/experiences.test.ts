import { describe, expect, it, vi } from "vitest";
import { buildExperienceForm, createExperienceItem, toDevProductItem, toGamePassItem } from "./experiences";
import { createClient } from "./http";

describe("game passes and developer products", () => {
  it("maps a game pass config", () => {
    expect(
      toGamePassItem(42, {
        gamePassId: 7,
        name: "VIP",
        description: "Perks",
        isForSale: true,
        priceInformation: { defaultPriceInRobux: 199, enabledFeatures: ["RegionalPricing"] },
        isManagedPricingEnabled: true,
      }),
    ).toEqual({
      key: "gamePass:7",
      kind: "gamePass",
      id: 7,
      universeId: 42,
      name: "VIP",
      description: "Perks",
      price: 199,
      onSale: true,
      managedPricing: true,
      regionalPricing: true,
    });
  });

  it("maps a developer product with no price yet", () => {
    expect(toDevProductItem(42, { productId: 9, name: "Coins", isForSale: false, priceInformation: null })).toMatchObject({
      key: "devProduct:9",
      price: null,
      managedPricing: false,
      regionalPricing: undefined,
    });
  });

  it("sends only the fields that changed", () => {
    expect([...buildExperienceForm({ price: 25 }).entries()]).toEqual([["price", "25"]]);
    expect([...buildExperienceForm({ onSale: false, managedPricing: true, regionalPricing: false }).entries()]).toEqual([
      ["isForSale", "false"],
      ["isManagedPricingEnabled", "true"],
      ["isRegionalPricingEnabled", "false"],
    ]);
    expect([...buildExperienceForm({ name: "VIP+", description: "" }).entries()]).toEqual([
      ["name", "VIP+"],
      ["description", ""],
    ]);
  });

  it("creates a developer product with every field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ productId: 55 }), { status: 200 }));
    const id = await createExperienceItem(createClient(fetchImpl), "devProduct", 42, {
      name: "Donate 10 Robux",
      description: "Thanks!",
      price: 10,
      onSale: true,
    });

    expect(id).toBe(55);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://apis.roblox.com/developer-products/v2/universes/42/developer-products");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({
      name: "Donate 10 Robux",
      description: "Thanks!",
      price: "10",
      isForSale: "true",
    });
  });
});
