import { jsonBody, type RobloxClient } from "./http";
import type { Creator } from "./types";

// Clothing that's been uploaded and approved but never published to the
// Marketplace. The catalog search only lists published items, so these come
// from the dashboard's own Creations list instead:
//   GET  itemconfiguration.roblox.com/v1/creations/get-assets?assetType=Shirt
//   POST itemconfiguration.roblox.com/v1/creations/get-asset-details {AssetIds}
// An item that passed review but was never published has status "ReviewApproved".

const ITEMCONFIG = "https://itemconfiguration.roblox.com";

/** Classic clothing, which Roblox charges a publishing fee for. Asset type name → id. */
export const CLASSIC_CLOTHING = { TShirt: 2, Shirt: 11, Pants: 12 } as const;

/** What Roblox charges to publish one classic clothing item. */
export const CLASSIC_PUBLISHING_FEE = 10;

const MAX_PAGES = 20;
const DETAILS_BATCH = 50;

export interface UnpublishedItem {
  id: number;
  name: string;
  assetType: number;
}

interface CreationsPage {
  data: { assetId: number; name: string }[];
  nextPageCursor?: string | null;
}

interface AssetDetails {
  assetId: number;
  name: string;
  status: string;
}

/** Classic clothing that passed review but was never published. `published` are ids already known to be on the Marketplace. */
export async function listUnpublishedClothing(client: RobloxClient, creator: Creator, published: Set<number>): Promise<UnpublishedItem[]> {
  const candidates: UnpublishedItem[] = [];
  for (const [typeName, assetType] of Object.entries(CLASSIC_CLOTHING)) {
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ assetType: typeName, isArchived: "false", limit: "100" });
      if (creator.type === "Group") params.set("groupId", String(creator.id));
      if (cursor) params.set("cursor", cursor);
      const res = await client.json<CreationsPage>(`${ITEMCONFIG}/v1/creations/get-assets?${params}`);
      for (const a of res.data ?? []) if (!published.has(a.assetId)) candidates.push({ id: a.assetId, name: a.name, assetType });
      if (!res.nextPageCursor) break;
      cursor = res.nextPageCursor;
    }
  }

  const approved = new Set<number>();
  for (let i = 0; i < candidates.length; i += DETAILS_BATCH) {
    const ids = candidates.slice(i, i + DETAILS_BATCH).map((c) => c.id);
    const details = await client.json<AssetDetails[]>(`${ITEMCONFIG}/v1/creations/get-asset-details`, {
      method: "POST",
      ...jsonBody({ AssetIds: ids }),
    });
    for (const d of details) if (d.status === "ReviewApproved") approved.add(d.assetId);
  }
  return candidates.filter((c) => approved.has(c.id));
}
