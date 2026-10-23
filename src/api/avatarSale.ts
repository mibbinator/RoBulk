import { jsonBody, type RobloxClient } from "./http";

// Avatar item (clothing, accessories, ...) sale settings.
//
// The Creator Dashboard saves with
//   PATCH itemconfiguration.roblox.com/v1/collectibles/{collectibleItemId}
// and that call replaces every sale setting at once, so we first read the
// item's current settings with
//   GET itemconfiguration.roblox.com/v1/items?itemType=0&itemId={assetId}
// and send them back unchanged apart from price and sale status. Field names
// and enum values below come from the dashboard's own client code.
const ITEMCONFIG = "https://itemconfiguration.roblox.com";

export const SaleStatus = { OnSale: 0, OffSale: 1 } as const;
const ResaleRestriction = { Resellable: 1, NotResellable: 2 } as const;
/** 1 shop + all experiences, 2 experiences only, 3 shop only, 4 shop + chosen experiences. */
const SALE_LOCATIONS_WITH_PLACES = new Set([2, 4]);
const LIMITED_COLLECTIBLE_TYPE = 1;

interface Timestamp {
  seconds?: number;
  Seconds?: number;
}

/** The parts of the dashboard's item read model RoBulk cares about. */
export interface MarketplaceItem {
  saleStatus?: number;
  price?: number;
  isCollectible?: boolean;
  collectibleItemType?: number;
  isRentalOptIn?: boolean;
  saleLocation?: { saleLocationType?: number; universeIds?: number[] } | null;
  collectibleDetails?: {
    collectibleItemId?: string;
    quantityLimitPerUser?: number;
    isResellable?: boolean;
  } | null;
  // Roblox sends these nested keys in PascalCase.
  dynamicPriceConfiguration?: {
    PriceOffset?: number;
    IsOptOutRegionalPricing?: boolean;
    MinimumPrice?: number;
  } | null;
  scheduledRelease?: { OnSaleTime?: Timestamp | null; OffSaleTime?: Timestamp | null } | null;
}

export interface SaleSettings {
  onSale: boolean;
  price: number;
}

/** Optional changes beyond price and sale status. */
export interface SaleOverrides {
  regionalPricing?: boolean;
  /** ISO timestamps; null clears that end of the schedule. */
  schedule?: { start: string | null; end: string | null };
}

export class UnsupportedItemError extends Error {}

export async function readMarketplaceItem(client: RobloxClient, assetId: number): Promise<MarketplaceItem> {
  const res = await client.json<{ item?: MarketplaceItem }>(`${ITEMCONFIG}/v1/items?itemType=0&itemId=${assetId}`);
  if (!res.item) throw new Error("Roblox returned no settings for this item");
  return res.item;
}

const toIso = (t: Timestamp | null | undefined) => {
  const seconds = t?.seconds ?? t?.Seconds;
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
};

/**
 * Builds the PATCH body from the item's current settings, changing only
 * price and sale status. `places` are the root place ids for the item's
 * chosen experiences (only used by sale locations 2 and 4).
 */
export function buildSalePayload(
  item: MarketplaceItem,
  { onSale, price }: SaleSettings,
  places: number[] = [],
  overrides: SaleOverrides = {},
) {
  if (!item.isCollectible || !item.collectibleDetails?.collectibleItemId) {
    throw new UnsupportedItemError("This item can't be configured through RoBulk");
  }
  if (item.collectibleItemType === LIMITED_COLLECTIBLE_TYPE) {
    throw new UnsupportedItemError("Limited items aren't supported yet; edit this one on the dashboard");
  }
  const saleLocationType = item.saleLocation?.saleLocationType;
  if (!saleLocationType) {
    throw new UnsupportedItemError("This item has no sale location set; set one on the dashboard first");
  }

  const pricing = item.dynamicPriceConfiguration;
  const schedule = overrides.schedule
    ? { onSaleTime: overrides.schedule.start ?? undefined, offSaleTime: overrides.schedule.end ?? undefined }
    : item.scheduledRelease
      ? { onSaleTime: toIso(item.scheduledRelease.OnSaleTime), offSaleTime: toIso(item.scheduledRelease.OffSaleTime) }
      : {};
  return {
    saleLocationConfiguration: {
      saleLocationType,
      places: SALE_LOCATIONS_WITH_PLACES.has(saleLocationType) ? places : [],
    },
    saleStatus: onSale ? SaleStatus.OnSale : SaleStatus.OffSale,
    quantityLimitPerUser: item.collectibleDetails.quantityLimitPerUser ?? 0,
    resaleRestriction: item.collectibleDetails.isResellable ? ResaleRestriction.Resellable : ResaleRestriction.NotResellable,
    priceInRobux: price,
    priceOffset: pricing?.PriceOffset ?? 0,
    isFree: price === 0,
    optOutFromRegionalPricing:
      overrides.regionalPricing !== undefined ? !overrides.regionalPricing : (pricing?.IsOptOutRegionalPricing ?? false),
    ...(item.isRentalOptIn ? { isRentalOptIn: true } : {}),
    ...schedule,
  };
}

/** Root place ids for the given universes (needed for experience-only sale locations). */
async function rootPlaceIds(client: RobloxClient, universeIds: number[]): Promise<number[]> {
  if (universeIds.length === 0) return [];
  // develop.roblox.com (unlike the public games API) also resolves private experiences.
  const res = await client.json<{ data: { id: number; rootPlaceId: number }[] }>(
    `https://develop.roblox.com/v1/universes/multiget?${universeIds.map((id) => `ids=${id}`).join("&")}`,
  );
  const places = res.data.map((u) => u.rootPlaceId).filter((id) => id > 0);
  if (places.length !== universeIds.length) {
    throw new Error("Couldn't look up this item's experiences, so it was left unchanged");
  }
  return places;
}

export async function saveAvatarItem(
  client: RobloxClient,
  assetId: number,
  settings: SaleSettings,
  overrides: SaleOverrides = {},
): Promise<void> {
  const item = await readMarketplaceItem(client, assetId);
  if (overrides.schedule) {
    // Clearing a schedule needs its own call; sending empty times doesn't remove it.
    const id = item.collectibleDetails?.collectibleItemId;
    if (id && item.scheduledRelease && !overrides.schedule.start && !overrides.schedule.end) {
      await client.request(`${ITEMCONFIG}/v1/collectibles/${encodeURIComponent(id)}/sale-schedule`, { method: "DELETE" });
    }
  }
  const location = item.saleLocation;
  const places =
    location?.saleLocationType && SALE_LOCATIONS_WITH_PLACES.has(location.saleLocationType)
      ? await rootPlaceIds(client, location.universeIds ?? [])
      : [];
  const payload = buildSalePayload(item, settings, places, overrides);
  const collectibleItemId = item.collectibleDetails!.collectibleItemId!;
  await client.request(`${ITEMCONFIG}/v1/collectibles/${encodeURIComponent(collectibleItemId)}`, {
    method: "PATCH",
    ...jsonBody(payload),
  });
}

/** Renames an avatar item and/or changes its description (both are always sent, as the dashboard does). */
export async function updateDisplayInfo(client: RobloxClient, assetId: number, name: string, description: string): Promise<void> {
  await client.request(`${ITEMCONFIG}/v1/collectibles/update-item-display-information`, {
    method: "PATCH",
    ...jsonBody({ targetType: 0, targetId: String(assetId), name, description }),
  });
}
