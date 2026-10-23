import { describe, expect, it, vi } from "vitest";
import { accessFromMembership, listCreators } from "./account";
import { createClient } from "./http";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const membership = (perms: Record<string, boolean>) => ({ permissions: { groupEconomyPermissions: perms } });

describe("accessFromMembership", () => {
  it("maps Roblox role permissions", () => {
    expect(accessFromMembership(membership({ manageItems: true, manageGroupGames: false, viewGroupPayouts: true }))).toEqual({
      avatarItems: true,
      experiences: false,
      earnings: true,
    });
    expect(accessFromMembership({})).toEqual({ avatarItems: false, experiences: false, earnings: false });
  });
});

describe("listCreators", () => {
  it("only offers groups the user can manage", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("users/authenticated")) return json({ id: 1, name: "me", displayName: "Me" });
      if (url.includes("/groups/roles")) {
        return json({
          data: [
            { group: { id: 10, name: "Store" }, role: { rank: 255 } },
            { group: { id: 20, name: "Fan club" }, role: { rank: 1 } },
            { group: { id: 30, name: "Studio" }, role: { rank: 50 } },
            { group: { id: 40, name: "Broken" }, role: { rank: 50 } },
          ],
        });
      }
      if (url.includes("/groups/10/membership")) return json(membership({ manageItems: true, manageGroupGames: true, spendGroupFunds: true }));
      if (url.includes("/groups/20/membership")) return json(membership({ manageItems: false, manageGroupGames: false }));
      if (url.includes("/groups/30/membership")) return json(membership({ manageGroupGames: true }));
      return json({ errors: [{ message: "nope" }] }, 500);
    });

    const creators = await listCreators(createClient(fetchImpl));

    expect(creators.map((c) => `${c.type}:${c.name}`)).toEqual(["User:me", "Group:Store", "Group:Studio"]);
    expect(creators[2].access).toEqual({ avatarItems: false, experiences: true, earnings: false });
  });
});
