import { describe, expect, it, vi } from "vitest";
import { listUnpublishedClothing } from "./creations";
import { createClient } from "./http";
import type { Creator } from "./types";

const group: Creator = { type: "Group", id: 5, name: "G", access: { avatarItems: true, experiences: true, earnings: true } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("listUnpublishedClothing", () => {
  it("finds clothing that passed review but was never published", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("get-assets") && url.includes("assetType=Shirt")) {
        if (!url.includes("cursor=")) return json({ data: [{ assetId: 1, name: "Published shirt" }, { assetId: 2, name: "Draft shirt" }], nextPageCursor: "c2" });
        return json({ data: [{ assetId: 3, name: "In review" }], nextPageCursor: null });
      }
      if (url.includes("get-assets") && url.includes("assetType=Pants")) return json({ data: [{ assetId: 4, name: "Draft pants" }] });
      if (url.includes("get-assets")) return json({ data: [] });
      if (url.includes("get-asset-details")) {
        const ids = JSON.parse(String(init.body)).AssetIds as number[];
        const status: Record<number, string> = { 2: "ReviewApproved", 3: "ReviewPending", 4: "ReviewApproved" };
        return json(ids.map((assetId) => ({ assetId, name: "", status: status[assetId] ?? "OffSale" })));
      }
      return new Response(null, { status: 404 });
    });

    const found = await listUnpublishedClothing(createClient(fetchImpl), group, new Set([1]));

    expect(found).toEqual([
      { id: 2, name: "Draft shirt", assetType: 11 },
      { id: 4, name: "Draft pants", assetType: 12 },
    ]);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe("https://itemconfiguration.roblox.com/v1/creations/get-assets?assetType=TShirt&isArchived=false&limit=100&groupId=5");
    expect(urls).toContain("https://itemconfiguration.roblox.com/v1/creations/get-assets?assetType=Shirt&isArchived=false&limit=100&groupId=5&cursor=c2");
    // Already-published items aren't looked up again.
    const detailsBody = fetchImpl.mock.calls.find((c) => String(c[0]).includes("get-asset-details"))![1]!.body;
    expect(JSON.parse(String(detailsBody))).toEqual({ AssetIds: [2, 3, 4] });
  });

  it("makes no details request when everything is published", async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ data: [{ assetId: 1, name: "Shirt" }] }));
    expect(await listUnpublishedClothing(createClient(fetchImpl), group, new Set([1]))).toEqual([]);
    expect(fetchImpl.mock.calls.every((c) => String(c[0]).includes("get-assets"))).toBe(true);
  });
});
