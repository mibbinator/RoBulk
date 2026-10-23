// A pretend Roblox API for the preview page, so the panel can be developed
// and screenshotted without signing in. The store (group, owner, items and
// thumbnails) comes from preview/fixtures/store.json, refreshed from a real
// group's public catalog by scripts/fetch-preview-data.mjs. Sales, passes,
// products and badges are generated sample data.

import store from "./fixtures/store.json";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];

interface FakeItem {
  id: number;
  assetType: number;
  name: string;
  price: number;
  onSale: boolean;
  thumb: string | null;
}

const items: FakeItem[] = store.items;

const experiences = [
  { id: 6401319371, name: "Homestore [Valor Designs]" },
  { id: 3789845033, name: "Gold Tycoon Empire [Alpha Release]" },
];

const passes = [
  { gamePassId: 901, name: "VIP Lounge", price: 249, onSale: true },
  { gamePassId: 902, name: "Radio", price: 99, onSale: true },
  { gamePassId: 903, name: "Early Access Drops", price: 399, onSale: false },
];
const products = [
  { productId: 801, name: "Donate 25 Robux", price: 25, onSale: true },
  { productId: 802, name: "Donate 100 Robux", price: 100, onSale: true },
  { productId: 803, name: "Donate 500 Robux", price: 500, onSale: true },
];

const BUYERS = ["builderman", "pixelqueen", "kaiju_kid", "sunny_dayz", "obbyking", "lavafloor", "starlight", "neonfox", "bloxxer", "drip_lord", "fitcheck", "moonwalker"];

// Popular items sell more: weight sales toward the front of the catalog.
const transactions = (() => {
  const list: { created: string; [field: string]: unknown }[] = [];
  const now = Date.now();
  for (let d = 0; d < 60; d++) {
    const sales = Math.round(14 + 14 * Math.sin(d / 5) ** 2 + rand() * 10 + (d < 20 ? 8 : 0));
    for (let s = 0; s < sales; s++) {
      const created = new Date(now - d * 86400000 - rand() * 86400000).toISOString();
      const roll = rand();
      const buyer = Math.floor(rand() * BUYERS.length);
      const agent = { id: 1000 + buyer, type: "User", name: BUYERS[buyer] };
      const base = { idHash: `${d}-${s}`, created, isPending: d < 3, agent };
      if (roll < 0.06) {
        const p = pick(passes);
        list.push({ ...base, details: { id: p.gamePassId, name: p.name, type: "GamePass" }, currency: { amount: Math.floor(p.price * 0.7), type: "Robux" } });
      } else if (roll < 0.14) {
        const p = pick(products);
        list.push({ ...base, details: { id: p.productId, name: p.name, type: "DeveloperProduct" }, currency: { amount: Math.floor(p.price * 0.7), type: "Robux" } });
      } else {
        const it = items[Math.floor(rand() ** 2.2 * items.length)];
        list.push({ ...base, details: { id: it.id, name: it.name, type: "Asset" }, currency: { amount: Math.max(1, Math.floor(it.price * 0.7)), type: "Robux" } });
      }
    }
  }
  return list.sort((a, b) => (b.created > a.created ? 1 : -1));
})();

const badges = [
  ["Welcome to Valor", 18_340, 96.2],
  ["First Fit", 7_512, 39.4],
  ["Window Shopper", 11_120, 58.3],
  ["Regular", 2_998, 15.7],
  ["Secret Changing Room", 451, 2.4],
  ["Group Member", 64, 0.3],
].map(([name, awarded, rate], i) => ({
  id: 700 + i,
  name,
  description: "",
  enabled: i !== 4,
  statistics: { awardedCount: awarded, pastDayAwardedCount: Math.round(Number(awarded) / 250), winRatePercentage: rate },
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Flat icons for things without a real thumbnail.
const SHAPES: Record<string, (fill: string) => string> = {
  shirt: (f) => `<path d="M52 30 L66 22 Q75 31 84 22 L98 30 L118 50 L106 62 L98 55 L98 122 L52 122 L52 55 L44 62 L32 50 Z" fill="${f}"/>`,
  pass: (f) => `<rect x="30" y="48" width="90" height="56" rx="10" fill="${f}"/><path d="M75 60 L80 72 L93 72 L83 80 L87 93 L75 85 L63 93 L67 80 L57 72 L70 72 Z" fill="#fff"/>`,
  coin: (f) => `<circle cx="75" cy="75" r="38" fill="${f}"/><circle cx="75" cy="75" r="28" fill="none" stroke="#fff" stroke-width="5" opacity=".7"/>`,
  badge: (f) => `<circle cx="75" cy="75" r="44" fill="${f}"/><path d="M75 47 L83 66 L104 66 L87 79 L93 99 L75 87 L57 99 L63 79 L46 66 L67 66 Z" fill="#fff"/>`,
};
const svgThumb = (shape: string, fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="#3a3e48"/>${SHAPES[shape](fill)}</svg>`)}`;

function thumbFor(param: string, id: number): string {
  if (param === "gamePassIds") return svgThumb("pass", ["#d9a930", "#7a5bd1", "#2fa39a"][id % 3]);
  if (param === "developerProductIds") return svgThumb("coin", ["#e8b730", "#d9a930", "#2fa39a"][id % 3]);
  if (param === "badgeIds") return svgThumb("badge", ["#3987e5", "#2fa39a", "#d9a930", "#7a5bd1", "#d94a4a", "#e8823a"][id % 6]);
  return items.find((i) => i.id === id)?.thumb ?? svgThumb("shirt", "#8d929b");
}

export async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const method = init.method ?? "GET";
  await new Promise((r) => setTimeout(r, 40));

  // ?unpublished: two shirts that were approved but never published.
  const unpublished = new URLSearchParams(location.search).has("unpublished");
  if (url.includes("/creations/get-assets")) {
    const drafts = [{ assetId: 501, name: "Camo Suit [+]" }, { assetId: 502, name: "Navy Blazer [+]" }];
    return json({ data: unpublished && url.includes("assetType=Shirt") ? drafts : [], nextPageCursor: null });
  }
  if (url.includes("/creations/get-asset-details")) {
    const ids: number[] = JSON.parse(String(init.body)).AssetIds;
    return json(ids.map((assetId) => ({ assetId, name: "", status: "ReviewApproved" })));
  }
  if (method !== "GET") return new Response(null, { status: 200 });
  if (url.includes("/users/authenticated")) return json({ id: store.owner.id, name: store.owner.name, displayName: store.owner.name });
  if (url.includes("/groups/roles")) return json({ data: [{ group: { id: store.group.id, name: store.group.name }, role: { rank: 255 } }] });
  if (url.includes("/membership")) return json({ permissions: { groupEconomyPermissions: { manageItems: true, manageGroupGames: true, spendGroupFunds: true } } });
  if (url.includes("catalog.roblox.com/v2/search")) {
    // The signed-in user's own (non-group) catalog is empty in the preview.
    if (new URL(url).searchParams.get("CreatorType") === "1") return json({ nextPageCursor: null, data: [] });
    return json({
      nextPageCursor: null,
      data: items.map((i) => ({ id: i.id, itemType: "Asset", assetType: i.assetType, name: i.name, price: i.price, priceStatus: i.onSale ? undefined : "Off Sale", collectibleItemId: `c-${i.id}` })),
    });
  }
  if (url.includes("revenue-split")) return json({ RevenueSplit: { creatorSplitPercentage: 70 } });
  if (url.includes("/universes?")) return json({ data: experiences, nextPageCursor: null });
  if (url.includes("/game-passes/creator")) {
    return json({
      gamePasses: passes.map((p) => ({ gamePassId: p.gamePassId, name: p.name, isForSale: p.onSale, priceInformation: { defaultPriceInRobux: p.price, enabledFeatures: ["RegionalPricing"] }, isManagedPricingEnabled: p.gamePassId === 901 })),
      nextPageToken: "",
    });
  }
  if (url.includes("/developer-products/creator")) {
    return json({
      developerProducts: products.map((p) => ({ productId: p.productId, name: p.name, isForSale: p.onSale, priceInformation: { defaultPriceInRobux: p.price, enabledFeatures: [] }, isManagedPricingEnabled: false })),
      nextPageToken: "",
    });
  }
  if (url.includes("thumbnails.roblox.com")) {
    const query = new URL(url).searchParams;
    const param = ["assetIds", "gamePassIds", "developerProductIds", "badgeIds"].find((p) => query.has(p))!;
    const ids = (query.get(param) ?? "").split(",").filter(Boolean).map(Number);
    return json({ data: ids.map((id) => ({ targetId: id, state: "Completed", imageUrl: thumbFor(param, id) })) });
  }
  if (url.includes("/transactions")) return json({ data: transactions, nextPageCursor: null });
  if (url.includes("/currency")) return json({ robux: 12_480 });
  if (url.includes("badges.roblox.com")) return json({ data: badges, nextPageCursor: null });
  return json({ errors: [{ message: `No fake for ${url}` }] }, 404);
}
