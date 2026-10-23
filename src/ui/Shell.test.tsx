// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";
import { forgetPageSales } from "./workspace";

// End-to-end checks of the panel against simulated Roblox responses.

type Call = { url: string; method: string; body: unknown };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function fakeRoblox() {
  const calls: Call[] = [];
  let csrfIssued = false;

  const shirtConfig = {
    isCollectible: true,
    collectibleItemType: 2,
    saleStatus: 1,
    saleLocation: { saleLocationType: 1, universeIds: [] },
    collectibleDetails: { collectibleItemId: "uuid-shirt", quantityLimitPerUser: 0, isResellable: false },
    dynamicPriceConfiguration: { PriceOffset: 0, IsOptOutRegionalPricing: true },
  };

  const sale = (created: string, robux: number, item: { id: number; name: string; type: string }, buyer = { id: 50, type: "User", name: "buyer1" }) => ({
    idHash: `${created}-${item.id}-${robux}`,
    created,
    isPending: false,
    agent: buyer,
    details: item,
    currency: { amount: robux, type: "Robux" },
  });

  const fetchImpl = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (method !== "GET" && !csrfIssued) {
      csrfIssued = true;
      return json({ errors: [{ message: "XSRF token invalid" }] }, 403, { "x-csrf-token": "tok" });
    }
    if (url.includes("users.roblox.com/v1/users/authenticated")) return json({ id: 1, name: "me", displayName: "Me" });
    if (url.includes("groups.roblox.com/v1/users/1/groups/roles")) return json({ data: [{ group: { id: 9, name: "Test Group" }, role: { rank: 255 } }] });
    if (url.includes("groups.roblox.com/v1/groups/9/membership")) {
      return json({ permissions: { groupEconomyPermissions: { manageItems: true, manageGroupGames: true, viewGroupPayouts: true } } });
    }
    if (url.includes("catalog.roblox.com/v2/search")) {
      return json({
        nextPageCursor: null,
        data: [
          { id: 101, itemType: "Asset", assetType: 11, name: "Off-sale shirt", price: 5, priceStatus: "Off Sale", collectibleItemId: "uuid-shirt" },
          { id: 102, itemType: "Asset", assetType: 11, name: "On-sale shirt", price: 15, collectibleItemId: "uuid-2" },
        ],
      });
    }
    if (url.includes("revenue-split")) {
      // Progressive like Roblox's: 30% at the R$5 floor, more as the price rises, capped at 70%.
      const price = Number(new URL(url).searchParams.get("MinimumPrice"));
      return json({ RevenueSplit: { creatorSplitPercentage: price <= 5 ? 30 : price <= 10 ? 50 : 70 } });
    }
    if (url.includes("develop.roblox.com/v1/user/universes")) return json({ data: [{ id: 42, name: "My Game" }], nextPageCursor: null });
    if (url.includes("/game-passes/creator")) {
      return json({
        gamePasses: [{ gamePassId: 7, name: "VIP", isForSale: false, priceInformation: { defaultPriceInRobux: 100, enabledFeatures: [] }, isManagedPricingEnabled: false }],
        nextPageToken: "",
      });
    }
    if (url.includes("/developer-products/creator")) return json({ developerProducts: [], nextPageToken: "" });
    if (url.includes("thumbnails.roblox.com")) return json({ data: [] });
    if (url.includes("itemconfiguration.roblox.com/v1/items?")) return json({ item: shirtConfig });
    if (url.includes("economy.roblox.com/v2/users/1/transactions")) {
      if (url.includes("cursor=older")) return json({ nextPageCursor: null, data: [sale(daysAgo(70), 4, { id: 102, name: "On-sale shirt", type: "Asset" })] });
      return json({
        nextPageCursor: "older",
        data: [
          sale(daysAgo(1), 70, { id: 7, name: "VIP", type: "GamePass" }),
          sale(daysAgo(2), 4, { id: 102, name: "On-sale shirt", type: "Asset" }),
          sale(daysAgo(3), 4, { id: 102, name: "On-sale shirt", type: "Asset" }, { id: 51, type: "User", name: "buyer2" }),
          sale(daysAgo(40), 4, { id: 102, name: "On-sale shirt", type: "Asset" }),
        ],
      });
    }
    if (url.includes("economy.roblox.com/v1/users/1/currency")) return json({ robux: 1234 });
    if (url.includes("games.roblox.com/v1/games/votes")) return json({ data: [{ id: 42, upVotes: 90, downVotes: 10 }] });
    if (url.includes("games.roblox.com/v1/games?universeIds=42")) {
      return json({ data: [{ id: 42, name: "My Game", creator: { id: 1, type: "User", name: "me" }, visits: 12345, playing: 7, favoritedCount: 321, created: daysAgo(400), updated: daysAgo(2) }] });
    }
    // One shirt uploaded and approved but never published.
    if (url.includes("/v1/creations/get-assets")) {
      return json({ data: url.includes("assetType=Shirt") ? [{ assetId: 101, name: "Off-sale shirt" }, { assetId: 900, name: "Draft shirt" }] : [] });
    }
    if (url.includes("/v1/creations/get-asset-details")) return json([{ assetId: 900, name: "Draft shirt", status: "ReviewApproved" }]);
    if (method === "PATCH") return new Response(null, { status: url.includes("collectibles") ? 200 : 204 });
    return json({ errors: [{ message: `unexpected ${method} ${url}` }] }, 404);
  });

  return { fetchImpl, calls };
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const byText = (root: ParentNode, selector: string, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? "")));

function choose(root: ParentNode, label: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const transactionCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/transactions")).length;

function mount() {
  const { fetchImpl, calls } = fakeRoblox();
  vi.stubGlobal("fetch", fetchImpl);
  vi.spyOn(console, "error").mockImplementation(() => {}); // Chart.js can't draw without a real canvas.
  const root = document.createElement("div");
  document.body.appendChild(root);
  render(<Shell onClose={() => {}} />, root);
  return { root, calls };
}

afterEach(() => {
  forgetPageSales();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Shell", () => {
  it("bulk puts off-sale items on sale, preserving hidden settings, and logs it", async () => {
    const { root, calls } = mount();

    await waitFor(() => byText(root, ".rb-group-toggle", /Classic Shirts/));
    // RoBulk opens on the clothing store; experiences are separate views.
    await waitFor(() => root.querySelector<HTMLSelectElement>('select[aria-label="Store or experience"] option[value="42"]'));
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="Store or experience"]')!.value).toBe("");
    expect(byText(root, ".rb-group-toggle", /Game Passes/)).toBeFalsy();
    // Per-sale earnings use the share for each item's own price.
    await waitFor(() => byText(root, ".rb-was", "you get R$1")); // 30% of R$5
    await waitFor(() => byText(root, ".rb-was", "you get R$10")); // 70% of R$15

    byText(root, ".rb-segmented button", "Off sale")!.click();
    await waitFor(() => !byText(root, ".rb-name a", "On-sale shirt"));
    byText(root, ".rb-toolbar button", "Select all")!.click();
    await waitFor(() => byText(root, ".rb-selection", "1 selected"));
    byText(root, ".rb-actions button", "Put on sale")!.click();
    (await waitFor(() => byText(root, ".rb-btn-primary", "Save 1 change"))).click();
    await waitFor(() => byText(root, ".rb-progress span", /^Saved 1 of 1\./));

    const collectiblePatch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/collectibles/uuid-shirt") && c.body)!;
    expect(collectiblePatch.body).toEqual({
      saleLocationConfiguration: { saleLocationType: 1, places: [] },
      saleStatus: 0,
      quantityLimitPerUser: 0,
      resaleRestriction: 2,
      priceInRobux: 5,
      priceOffset: 0,
      isFree: false,
      optOutFromRegionalPricing: true, // read from the item, not reset
    });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("uuid-2"))).toBe(false);

    // The experience shows only its passes and products.
    choose(root, "Store or experience", "42");
    await waitFor(() => byText(root, ".rb-group-toggle", /Game Passes/));
    expect(byText(root, ".rb-group-toggle", /Classic Shirts/)).toBeFalsy();
    byText(root, ".rb-toolbar button", "Select all")!.click();
    await waitFor(() => byText(root, ".rb-selection", "1 selected"));
    byText(root, ".rb-actions button", "Put on sale")!.click();
    (await waitFor(() => byText(root, ".rb-btn-primary", "Save 1 change"))).click();
    // (The shirt save's "Saved 1 of 1" is still showing, so wait for the request itself.)
    await waitFor(() => calls.some((c) => c.method === "PATCH" && c.url.includes("/game-passes/7")));
    const passPatches = calls.filter((c) => c.method === "PATCH" && c.url.includes("/game-passes/7"));
    expect(passPatches.at(-1)!.url).toBe("https://apis.roblox.com/game-passes/v1/universes/42/game-passes/7");
    expect(passPatches.at(-1)!.body).toEqual({ isForSale: "true" });

    // The saves show up in History, with a "before" snapshot to undo them.
    byText(root, ".rb-tabs button", "History")!.click();
    await waitFor(() => byText(root, "td", "Before a save"));
    byText(root, ".rb-segmented button", "Activity log")!.click();
    await waitFor(() => byText(root, "td", "VIP"));
  }, 20000);

  it("opens on the group selected in the Creator Dashboard", async () => {
    localStorage.setItem("creatorHubGroup.1", "9");
    const { root } = mount();

    await waitFor(() => root.querySelector<HTMLSelectElement>('select[aria-label="Creator"]')?.value === "Group:9");
  }, 20000);

  it("switches report ranges instantly, without re-fetching or dimming", async () => {
    const { root, calls } = mount();
    await waitFor(() => byText(root, ".rb-group-toggle", /Classic Shirts/));
    byText(root, ".rb-tabs button", "Earnings report")!.click();
    await waitFor(() => byText(root, ".rb-stat", /Earned, last 30 days/));
    const fetches = transactionCalls(calls);

    byText(root, ".rb-segmented button", "Last 7 days")!.click();
    const week = await waitFor(() => byText(root, ".rb-stat", /Earned, last 7 days/));
    expect(week.querySelector(".rb-stat-value")!.textContent).toBe("R$8");
    expect(root.querySelector(".is-refreshing")).toBeNull();
    expect(transactionCalls(calls)).toBe(fetches);

    byText(root, ".rb-segmented button", "All time")!.click();
    const all = await waitFor(() => byText(root, ".rb-stat", /Earned, all time/));
    expect(all.querySelector(".rb-stat-value")!.textContent).toBe("R$16"); // every shirt sale, including 40 and 70 days ago
    expect(all.querySelector(".rb-stat-hint")!.textContent).toMatch(/^Since /);
    expect(all.querySelector(".rb-stat-delta")).toBeNull(); // nothing to compare all-time with

    // 7 days came from the sales already loaded; all time carried on from where 30 days stopped.
    expect(transactionCalls(calls)).toBe(fetches + 1);
    expect(calls.filter((c) => c.url.includes("/transactions")).at(-1)!.url).toContain("cursor=older");

    // Now everything is loaded, so going back to 30 days needs no fetch at all.
    byText(root, ".rb-segmented button", "Last 30 days")!.click();
    await waitFor(() => byText(root, ".rb-stat", /Earned, last 30 days/));
    expect(transactionCalls(calls)).toBe(fetches + 1);
  }, 20000);

  it("keeps sales for the whole page visit: reopening RoBulk doesn't ask Roblox again", async () => {
    const { root, calls } = mount();
    await waitFor(() => byText(root, ".rb-group-toggle", /Classic Shirts/));
    byText(root, ".rb-tabs button", "Earnings report")!.click();
    await waitFor(() => byText(root, ".rb-stat", /Earned, last 30 days/));
    const fetches = transactionCalls(calls);

    // Close RoBulk and open it again.
    render(null, root);
    render(<Shell onClose={() => {}} />, root);

    // The Items tab shows per-item sales straight away, without clicking "Load sales".
    await waitFor(() => byText(root, ".rb-meta-btn", /2 sold/));
    byText(root, ".rb-tabs button", "Earnings report")!.click();
    const earned = await waitFor(() => byText(root, ".rb-stat", /Earned, last 30 days/));
    expect(earned.querySelector(".rb-stat-value")!.textContent).toBe("R$8");
    expect(transactionCalls(calls)).toBe(fetches);

    // Refresh is the way to fetch again.
    byText(root, ".rb-toolbar button", "Refresh")!.click();
    await waitFor(() => transactionCalls(calls) === fetches + 1);
  }, 20000);

  it("looks up the creator share again when a price is changed", async () => {
    const { root, calls } = mount();
    await waitFor(() => byText(root, ".rb-was", "you get R$1"));

    const input = root.querySelector<HTMLInputElement>('input[aria-label="Price for Off-sale shirt"]')!;
    input.value = "10";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => byText(root, ".rb-was", "you get R$5")); // 50% of R$10
    expect(calls.some((c) => c.url.includes("revenue-split") && c.url.includes("MinimumPrice=10"))).toBe(true);
  }, 20000);

  it("builds the earnings report from sale transactions", async () => {
    const { root } = mount();
    await waitFor(() => byText(root, ".rb-group-toggle", /Classic Shirts/));

    byText(root, ".rb-tabs button", "Earnings report")!.click();

    const earned = await waitFor(() => byText(root, ".rb-stat", /Earned, last 30 days/));
    // The clothing store's own sales: two shirts this month.
    expect(earned.querySelector(".rb-stat-value")!.textContent).toBe("R$8");
    // Previous 30 days had one R$4 sale.
    expect(earned.querySelector(".rb-stat-delta")!.textContent).toMatch(/▲ 100% vs previous period/);
    expect(byText(root, ".rb-stat", /^Sales/)!.querySelector(".rb-stat-value")!.textContent).toBe("2");
    expect(byText(root, ".rb-stat", /Current balance/)!.querySelector(".rb-stat-value")!.textContent).toBe("R$1,234");
    // Category legend carries labels and values (not color alone).
    expect(byText(root, ".rb-legend li", /Classic Shirts\s*R\$8/)).toBeTruthy();
    expect(byText(root, ".rb-legend li", /Game Passes/)).toBeFalsy();

    // The experience's report: its game pass sale and its stats, without asking Roblox for sales again.
    choose(root, "Store or experience", "42");
    const gameEarned = await waitFor(() => {
      const tile = byText(root, ".rb-stat", /Earned, last 30 days/);
      return tile?.querySelector(".rb-stat-value")!.textContent === "R$70" && tile;
    });
    expect(gameEarned).toBeTruthy();
    await waitFor(() => byText(root, ".rb-stat", /Visits/));
    expect(byText(root, ".rb-stat", /Visits/)!.querySelector(".rb-stat-value")!.textContent).toBe("12,345");
    expect(byText(root, ".rb-stat", /Rating/)!.querySelector(".rb-stat-value")!.textContent).toBe("90%");
    expect(byText(root, "td a", "buyer1")).toBeTruthy();
  }, 20000);
  it("loads sales in the background, and the Options tab can switch features off", async () => {
    const { root, calls } = mount();
    await waitFor(() => byText(root, ".rb-was", "you get R$1"));
    // Sales were fetched without opening the Earnings report.
    await waitFor(() => byText(root, ".rb-meta-btn", /sold/));
    expect(transactionCalls(calls)).toBeGreaterThan(0);

    byText(root, ".rb-tabs button", "Options")!.click();
    const perSale = await waitFor(() => byText(root, ".rb-option", /Show what you get per sale/));
    const box = perSale.querySelector<HTMLInputElement>("input")!;
    expect(box.checked).toBe(true);
    box.click();

    byText(root, ".rb-tabs button", "Items")!.click();
    await waitFor(() => byText(root, ".rb-group-toggle", /Classic Shirts/));
    expect(byText(root, ".rb-was", /you get/)).toBeUndefined();
  }, 20000);
  it("warns about clothing that isn't published yet, since publishing costs Robux", async () => {
    const { root } = mount();
    const banner = await waitFor(() => root.querySelector<HTMLElement>(".rb-unpublished"));
    expect(banner.textContent).toMatch(/1 clothing item isn't published yet/);
    expect(banner.textContent).toContain("R$10 publishing fee");

    byText(banner, "button", "Show them")!.click();
    const link = await waitFor(() => byText(root, ".rb-unpublished a", "Draft shirt"));
    expect(link.getAttribute("href")).toBe("https://create.roblox.com/dashboard/creations/catalog/900/configure");

    byText(banner, "button", "Dismiss")!.click();
    await waitFor(() => !root.querySelector(".rb-unpublished"));
  }, 20000);
  it("opens on the creator from an off-sale warning with those items staged back on sale", async () => {
    const { fetchImpl } = fakeRoblox();
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Shell onClose={() => {}} opening={{ creatorKey: "User:1", stageOnSale: [101] }} />, root);

    // 101 is the off-sale shirt: it's staged on sale, ready to review and save.
    await waitFor(() => byText(root, ".rb-tab-badge", "1"));
    expect(byText(root, ".rb-tabs button", /Items/)!.textContent).toContain("1");
  }, 20000);
  it("opens on the experience whose dashboard page RoBulk was opened from", async () => {
    const { fetchImpl } = fakeRoblox();
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Shell onClose={() => {}} opening={{ universeId: 42 }} />, root);

    await waitFor(() => root.querySelector<HTMLSelectElement>('select[aria-label="Store or experience"]')?.value === "42");
    await waitFor(() => byText(root, ".rb-group-toggle", /Game Passes/));
    expect(byText(root, ".rb-group-toggle", /Classic Shirts/)).toBeFalsy();
  }, 20000);
});
