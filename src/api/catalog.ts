import type { RobloxClient } from "./http";
import { itemKey, type Creator, type SellableItem } from "./types";

// Public catalog search. With IncludeNotForSale it lists a creator's off-sale
// items too, and each result carries the collectibleItemId needed for saving.
const SEARCH_URL = "https://catalog.roblox.com/v2/search/items/details";
const PAGE_LIMIT = 120;
const MAX_PAGES = 100;

export interface CatalogSearchItem {
  id: number;
  itemType: string;
  assetType?: number;
  name: string;
  description?: string | null;
  price?: number | null;
  lowestPrice?: number | null;
  priceStatus?: string;
  isOffSale?: boolean;
  collectibleItemId?: string | null;
}

interface CatalogSearchPage {
  data: CatalogSearchItem[];
  nextPageCursor: string | null;
}

export function toAvatarItem(raw: CatalogSearchItem): SellableItem | null {
  if (raw.itemType !== "Asset" || raw.assetType == null) return null;
  const offSale = raw.isOffSale === true || raw.priceStatus === "Off Sale";
  return {
    key: itemKey("avatar", raw.id),
    kind: "avatar",
    id: raw.id,
    assetType: raw.assetType,
    name: raw.name,
    description: raw.description ?? "",
    collectibleItemId: raw.collectibleItemId ?? null,
    price: raw.price ?? raw.lowestPrice ?? null,
    onSale: !offSale,
  };
}

export async function listAvatarItems(client: RobloxClient, creator: Creator): Promise<SellableItem[]> {
  const items: SellableItem[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      CreatorType: creator.type === "Group" ? "2" : "1",
      CreatorTargetId: String(creator.id),
      IncludeNotForSale: "true",
      SortType: "3", // most recently updated first
      Limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set("Cursor", cursor);
    const res = await client.json<CatalogSearchPage>(`${SEARCH_URL}?${params}`);
    for (const raw of res.data) {
      const item = toAvatarItem(raw);
      if (item) items.push(item);
    }
    if (!res.nextPageCursor) break;
    cursor = res.nextPageCursor;
  }
  return items;
}
