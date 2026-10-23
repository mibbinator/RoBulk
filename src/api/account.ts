import type { RobloxClient } from "./http";
import type { Creator, CreatorAccess } from "./types";

interface AuthenticatedUser {
  id: number;
  name: string;
  displayName: string;
}

interface GroupRolesResponse {
  data: { group: { id: number; name: string }; role: { rank: number } }[];
}

interface MembershipResponse {
  permissions?: {
    groupEconomyPermissions?: {
      manageItems?: boolean;
      manageGroupGames?: boolean;
      spendGroupFunds?: boolean;
      viewGroupPayouts?: boolean;
    };
  };
}

const FULL_ACCESS: CreatorAccess = { avatarItems: true, experiences: true, earnings: true };

export function accessFromMembership(m: MembershipResponse): CreatorAccess {
  const p = m.permissions?.groupEconomyPermissions ?? {};
  return {
    avatarItems: p.manageItems === true,
    experiences: p.manageGroupGames === true,
    earnings: p.viewGroupPayouts === true || p.spendGroupFunds === true,
  };
}

/** Runs `fn` over `inputs` with at most `limit` requests in flight. */
async function mapLimited<T, R>(inputs: T[], limit: number, fn: (input: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const i = next++;
      results[i] = await fn(inputs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
}

/**
 * The signed-in user followed by the groups whose items or experiences they
 * are allowed to manage. Groups where their role can't change anything are
 * left out, as are groups whose permissions couldn't be checked.
 */
export async function listCreators(client: RobloxClient): Promise<Creator[]> {
  const me = await client.json<AuthenticatedUser>("https://users.roblox.com/v1/users/authenticated");
  const groups = await client.json<GroupRolesResponse>(`https://groups.roblox.com/v1/users/${me.id}/groups/roles`);
  const sorted = groups.data.slice().sort((a, b) => b.role.rank - a.role.rank);

  const checked = await mapLimited(sorted, 6, async (g): Promise<Creator | null> => {
    try {
      const membership = await client.json<MembershipResponse>(`https://groups.roblox.com/v1/groups/${g.group.id}/membership`);
      const access = accessFromMembership(membership);
      if (!access.avatarItems && !access.experiences) return null;
      return { type: "Group", id: g.group.id, name: g.group.name, access };
    } catch {
      return null;
    }
  });

  return [{ type: "User", id: me.id, name: me.name, access: FULL_ACCESS }, ...checked.filter((c): c is Creator => c !== null)];
}
