import type { RobloxClient } from "./http";

const BATCH = 100;

interface ThumbnailResponse {
  data: { targetId: number; state: string; imageUrl: string | null }[];
}

export async function getAssetThumbnails(client: RobloxClient, assetIds: number[]): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  for (let i = 0; i < assetIds.length; i += BATCH) {
    const ids = assetIds.slice(i, i + BATCH).join(",");
    const res = await client.json<ThumbnailResponse>(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=150x150&format=Png`,
    );
    for (const t of res.data) if (t.state === "Completed" && t.imageUrl) urls.set(t.targetId, t.imageUrl);
  }
  return urls;
}
