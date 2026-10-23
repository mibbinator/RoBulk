import { describe, expect, it, vi } from "vitest";
import { createClient } from "../api/http";
import type { SellableItem } from "../api/types";
import { pendingChanges, setEdit } from "./edits";
import { saveChange } from "./save";

const shirt: SellableItem = { key: "avatar:5", kind: "avatar", id: 5, assetType: 11, name: "Shirt", description: "Old", price: 5, onSale: false };
const pass: SellableItem = { key: "gamePass:7", kind: "gamePass", id: 7, universeId: 42, name: "VIP", price: 100, onSale: true, managedPricing: false };

const shirtConfig = {
  item: {
    isCollectible: true,
    collectibleItemType: 2,
    saleLocation: { saleLocationType: 1 },
    collectibleDetails: { collectibleItemId: "uuid", quantityLimitPerUser: 0, isResellable: false },
    dynamicPriceConfiguration: { PriceOffset: 0, IsOptOutRegionalPricing: false },
  },
};

function fakeFetch() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.includes("/v1/items?")) return new Response(JSON.stringify(shirtConfig));
    return new Response(null, { status: 200 });
  });
  return { calls, client: createClient(fetchImpl) };
}

const changeFor = (item: SellableItem, patch: Parameters<typeof setEdit>[2]) => pendingChanges([item], setEdit(new Map(), item, patch))[0];

describe("saveChange", () => {
  it("renames an avatar item without touching its sale settings", async () => {
    const { calls, client } = fakeFetch();
    await saveChange(client, changeFor(shirt, { name: "New Shirt" }));

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH https://itemconfiguration.roblox.com/v1/collectibles/update-item-display-information",
    ]);
    expect(calls[0].body).toEqual({ targetType: 0, targetId: "5", name: "New Shirt", description: "Old" });
  });

  it("turns regional pricing off and schedules a sale for an avatar item", async () => {
    const { calls, client } = fakeFetch();
    await saveChange(client, changeFor(shirt, { regionalPricing: false, schedule: { start: "2026-11-27T05:00:00.000Z", end: "2026-12-01T05:00:00.000Z" }, onSale: true }));

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("https://itemconfiguration.roblox.com/v1/collectibles/uuid");
    expect(patch.body).toMatchObject({
      saleStatus: 0,
      optOutFromRegionalPricing: true,
      onSaleTime: "2026-11-27T05:00:00.000Z",
      offSaleTime: "2026-12-01T05:00:00.000Z",
    });
  });

  it("sends a pass's changed fields in one request", async () => {
    const { calls, client } = fakeFetch();
    await saveChange(client, changeFor(pass, { name: "VIP+", price: 150, regionalPricing: true }));

    expect(calls).toEqual([
      {
        url: "https://apis.roblox.com/game-passes/v1/universes/42/game-passes/7",
        method: "PATCH",
        body: { name: "VIP+", price: "150", isRegionalPricingEnabled: "true" },
      },
    ]);
  });
});
