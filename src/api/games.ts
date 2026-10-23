import type { RobloxClient } from "./http";
import type { CreatorType } from "./types";

// Public details of an experience: who owns it, and its headline stats.
//   GET games.roblox.com/v1/games?universeIds=…
//   GET games.roblox.com/v1/games/votes?universeIds=…

const GAMES = "https://games.roblox.com";

export interface GameStats {
  universeId: number;
  name: string;
  creator: { id: number; type: CreatorType; name: string };
  visits: number;
  playing: number;
  favorites: number;
  upVotes: number | null;
  downVotes: number | null;
  created: string;
  updated: string;
}

interface GamesResponse {
  data: {
    id: number;
    name: string;
    creator: { id: number; type: string; name: string };
    visits: number;
    playing: number;
    favoritedCount: number;
    created: string;
    updated: string;
  }[];
}

interface VotesResponse {
  data: { id: number; upVotes: number; downVotes: number }[];
}

export async function getGameStats(client: RobloxClient, universeId: number): Promise<GameStats | null> {
  const [games, votes] = await Promise.all([
    client.json<GamesResponse>(`${GAMES}/v1/games?universeIds=${universeId}`),
    client.json<VotesResponse>(`${GAMES}/v1/games/votes?universeIds=${universeId}`).catch(() => null),
  ]);
  const g = games.data[0];
  if (!g) return null;
  const v = votes?.data[0];
  return {
    universeId: g.id,
    name: g.name,
    creator: { id: g.creator.id, type: g.creator.type === "Group" ? "Group" : "User", name: g.creator.name },
    visits: g.visits,
    playing: g.playing,
    favorites: g.favoritedCount,
    upVotes: v?.upVotes ?? null,
    downVotes: v?.downVotes ?? null,
    created: g.created,
    updated: g.updated,
  };
}

/** The universe id of the experience a Creator Dashboard page is about, if it's one. */
export function universeFromPath(path: string): number | null {
  const m = path.match(/^\/dashboard\/creations\/experiences\/(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : null;
}
