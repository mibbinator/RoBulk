import type { RobloxClient } from "./http";
import type { SellableItem } from "./types";

const BATCH = 100;

interface ThumbnailResponse {
  data: { targetId: number; state: string; imageUrl: string | null }[];
}

const ENDPOINTS = {
  avatar: (ids: string) => `https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=150x150&format=Png`,
  gamePass: (ids: string) => `https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${ids}&size=150x150&format=Png`,
  devProduct: (ids: string) =>
    `https://thumbnails.roblox.com/v1/developer-products/icons?developerProductIds=${ids}&size=150x150&format=Png`,
};

/** Thumbnail URLs keyed by item key. Missing thumbnails are simply left out. */
export async function getThumbnails(client: RobloxClient, items: SellableItem[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const kind of ["avatar", "gamePass", "devProduct"] as const) {
    const ids = items.filter((i) => i.kind === kind).map((i) => i.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      try {
        const res = await client.json<ThumbnailResponse>(ENDPOINTS[kind](ids.slice(i, i + BATCH).join(",")));
        for (const t of res.data) if (t.state === "Completed" && t.imageUrl) urls.set(`${kind}:${t.targetId}`, t.imageUrl);
      } catch {
        // Thumbnails are cosmetic; carry on without them.
      }
    }
  }
  return urls;
}

/** Badge icon URLs keyed by badge id. */
export async function getBadgeIcons(client: RobloxClient, badgeIds: number[]): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  for (let i = 0; i < badgeIds.length; i += BATCH) {
    try {
      const ids = badgeIds.slice(i, i + BATCH).join(",");
      const res = await client.json<ThumbnailResponse>(`https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${ids}&size=150x150&format=Png`);
      for (const t of res.data) if (t.state === "Completed" && t.imageUrl) urls.set(t.targetId, t.imageUrl);
    } catch {
      // Cosmetic only.
    }
  }
  return urls;
}
