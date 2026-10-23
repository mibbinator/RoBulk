import { jsonBody, type RobloxClient } from "./http";

const BADGES = "https://badges.roblox.com";

export interface Badge {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  iconImageId?: number;
  awardedCount: number;
  pastDayAwardedCount: number;
  winRatePercentage: number;
}

interface RawBadge {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  iconImageId?: number;
  statistics?: { pastDayAwardedCount?: number; awardedCount?: number; winRatePercentage?: number };
}

export function toBadge(raw: RawBadge): Badge {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? "",
    enabled: raw.enabled,
    iconImageId: raw.iconImageId,
    awardedCount: raw.statistics?.awardedCount ?? 0,
    pastDayAwardedCount: raw.statistics?.pastDayAwardedCount ?? 0,
    winRatePercentage: raw.statistics?.winRatePercentage ?? 0,
  };
}

export async function listBadges(client: RobloxClient, universeId: number): Promise<Badge[]> {
  const badges: Badge[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ limit: "100", sortOrder: "Asc" });
    if (cursor) params.set("cursor", cursor);
    const res = await client.json<{ data: RawBadge[]; nextPageCursor: string | null }>(
      `${BADGES}/v1/universes/${universeId}/badges?${params}`,
    );
    badges.push(...res.data.map(toBadge));
    if (!res.nextPageCursor) break;
    cursor = res.nextPageCursor;
  }
  return badges;
}

export interface BadgeChanges {
  name?: string;
  description?: string;
  enabled?: boolean;
}

export async function updateBadge(client: RobloxClient, badgeId: number, changes: BadgeChanges): Promise<void> {
  await client.request(`${BADGES}/v1/badges/${badgeId}`, { method: "PATCH", ...jsonBody(changes) });
}
