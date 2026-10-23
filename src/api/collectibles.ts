import { jsonBody, type RobloxClient } from "./http";

// Avatar item sale settings, as sent by the Creator Dashboard itself
// (captured from a manual save on 2026-10-23):
//   PATCH https://itemconfiguration.roblox.com/v1/collectibles/{collectibleItemId}
// saleStatus: 0 = on sale, 1 = off sale. Success returns an empty body.
const COLLECTIBLES_URL = "https://itemconfiguration.roblox.com/v1/collectibles";

export const SaleStatus = { OnSale: 0, OffSale: 1 } as const;

export interface SaleSettings {
  onSale: boolean;
  price: number;
}

/**
 * Builds the PATCH body. Fields other than price and sale status use the
 * values the dashboard sent for a standard classic clothing item.
 * TODO: Roblox exposes no read endpoint for these, so items with custom
 * regional pricing, purchase limits or sale locations would be reset. Find
 * the dashboard's read call and preserve those fields before wider release.
 */
export function buildSalePayload({ onSale, price }: SaleSettings) {
  return {
    saleLocationConfiguration: { saleLocationType: 1, places: [] },
    saleStatus: onSale ? SaleStatus.OnSale : SaleStatus.OffSale,
    quantityLimitPerUser: 0,
    resaleRestriction: 2,
    priceInRobux: price,
    priceOffset: 0,
    isFree: false,
    optOutFromRegionalPricing: false,
  };
}

export async function updateSale(client: RobloxClient, collectibleItemId: string, settings: SaleSettings): Promise<void> {
  await client.request(`${COLLECTIBLES_URL}/${encodeURIComponent(collectibleItemId)}`, {
    method: "PATCH",
    ...jsonBody(buildSalePayload(settings)),
  });
}
