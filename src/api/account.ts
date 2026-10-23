import type { RobloxClient } from "./http";
import type { Creator } from "./types";

interface AuthenticatedUser {
  id: number;
  name: string;
  displayName: string;
}

interface GroupRolesResponse {
  data: { group: { id: number; name: string }; role: { rank: number } }[];
}

/** The signed-in user followed by every group they belong to. */
export async function listCreators(client: RobloxClient): Promise<Creator[]> {
  const me = await client.json<AuthenticatedUser>("https://users.roblox.com/v1/users/authenticated");
  const groups = await client.json<GroupRolesResponse>(`https://groups.roblox.com/v1/users/${me.id}/groups/roles`);
  return [
    { type: "User", id: me.id, name: me.name },
    ...groups.data
      .slice()
      .sort((a, b) => b.role.rank - a.role.rank)
      .map((g): Creator => ({ type: "Group", id: g.group.id, name: g.group.name })),
  ];
}
