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

const CREATORS_KEY = "creators";
const CREATORS_FRESH_MS = 60 * 60_000;

/**
 * listCreators, remembered for an hour. Checking every group's permissions
 * takes a request per group, which is too many to repeat on every dashboard
 * page; the RoBulk panel itself always asks fresh.
 */
export async function cachedCreators(
  client: RobloxClient,
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  now = Date.now(),
): Promise<Creator[]> {
  const saved = (await storage.get(CREATORS_KEY).catch(() => undefined)) as { at: number; list: Creator[] } | undefined;
  if (saved && now - saved.at < CREATORS_FRESH_MS && saved.list.length) return saved.list;
  const list = await listCreators(client);
  await storage.set(CREATORS_KEY, { at: now, list }).catch(() => {});
  return list;
}

/** Looks up a Roblox user by username. Null when there's no such user. */
export async function findUser(client: RobloxClient, username: string): Promise<{ id: number; name: string } | null> {
  const res = await client.json<{ data: { id: number; name: string }[] }>("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    body: JSON.stringify({ usernames: [username.trim()], excludeBannedUsers: true }),
    headers: { "Content-Type": "application/json" },
  });
  return res.data[0] ?? null;
}
