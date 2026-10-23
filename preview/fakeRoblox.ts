// A pretend Roblox API for the preview page, so the panel can be developed
// and screenshotted without a Roblox account. Data is deterministic.

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];

const COLORS = ["Black", "White", "Red", "Navy", "Olive", "Pink", "Cream", "Grey", "Purple", "Orange"];
const SHIRTS = ["Hoodie", "Varsity Jacket", "Tracksuit Top", "Flannel", "Puffer", "Polo", "Graphic Tee", "Turtleneck"];
const PANTS = ["Cargos", "Jeans", "Joggers", "Tracksuit Bottoms", "Shorts", "Slacks"];

interface FakeItem {
  id: number;
  assetType: number;
  name: string;
  price: number;
  onSale: boolean;
}

const items: FakeItem[] = [];
let nextId = 10_000_000_000;
for (let i = 0; i < 34; i++) items.push({ id: nextId++, assetType: 11, name: `${pick(COLORS)} ${pick(SHIRTS)}`, price: pick([5, 10, 15, 25]), onSale: rand() > 0.6 });
for (let i = 0; i < 26; i++) items.push({ id: nextId++, assetType: 12, name: `${pick(COLORS)} ${pick(PANTS)}`, price: pick([5, 10, 15]), onSale: rand() > 0.6 });
for (let i = 0; i < 4; i++) items.push({ id: nextId++, assetType: 2, name: `${pick(COLORS)} Logo T-Shirt`, price: 5, onSale: true });
for (let i = 0; i < 3; i++) items.push({ id: nextId++, assetType: 8, name: `${pick(COLORS)} Beanie`, price: 75, onSale: true });

const passes = [
  { gamePassId: 901, name: "VIP", price: 299, onSale: true },
  { gamePassId: 902, name: "2x XP", price: 199, onSale: true },
  { gamePassId: 903, name: "Radio", price: 99, onSale: false },
];
const products = [
  { productId: 801, name: "100 Coins", price: 25, onSale: true },
  { productId: 802, name: "550 Coins", price: 120, onSale: true },
  { productId: 803, name: "Donate 100 Robux", price: 100, onSale: true },
];

const BUYERS = ["builderman", "noobmaster", "pixelqueen", "kaiju_kid", "sunny_dayz", "obbyking", "lavafloor", "starlight", "neonfox", "bloxxer"];

const transactions = (() => {
  const list: unknown[] = [];
  const now = Date.now();
  for (let d = 0; d < 60; d++) {
    const sales = Math.round(6 + 10 * Math.sin(d / 5) ** 2 + rand() * 8 + (d < 20 ? 6 : 0));
    for (let s = 0; s < sales; s++) {
      const created = new Date(now - d * 86400000 - rand() * 86400000).toISOString();
      const roll = rand();
      const buyer = Math.floor(rand() * BUYERS.length);
      const agent = { id: 1000 + buyer, type: "User", name: BUYERS[buyer] };
      if (roll < 0.08) {
        const p = pick(passes);
        list.push({ idHash: `${d}-${s}`, created, isPending: d < 3, agent, details: { id: p.gamePassId, name: p.name, type: "GamePass" }, currency: { amount: Math.floor(p.price * 0.7), type: "Robux" } });
      } else if (roll < 0.2) {
        const p = pick(products);
        list.push({ idHash: `${d}-${s}`, created, isPending: d < 3, agent, details: { id: p.productId, name: p.name, type: "DeveloperProduct" }, currency: { amount: Math.floor(p.price * 0.7), type: "Robux" } });
      } else {
        const it = items[Math.floor(rand() ** 2 * items.length)];
        list.push({ idHash: `${d}-${s}`, created, isPending: d < 3, agent, details: { id: it.id, name: it.name, type: "Asset" }, currency: { amount: Math.floor(it.price * 0.7), type: "Robux" } });
      }
    }
  }
  return list.sort((a, b) => ((b as { created: string }).created > (a as { created: string }).created ? 1 : -1));
})();

const badges = [
  ["Welcome!", 182_340, 98.1],
  ["First Win", 120_512, 66.3],
  ["Speedrunner", 8_120, 4.4],
  ["Collector", 30_998, 17.0],
  ["Secret Room", 2_051, 1.1],
  ["Veteran", 15_220, 8.3],
].map(([name, awarded, rate], i) => ({ id: 700 + i, name, description: "", enabled: i !== 4, statistics: { awardedCount: awarded, pastDayAwardedCount: Math.round(Number(awarded) / 300), winRatePercentage: rate } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const svgThumb = (label: string, hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" rx="16" fill="hsl(${hue} 45% 55%)"/><text x="75" y="92" font-size="56" text-anchor="middle" fill="white" font-family="sans-serif">${label}</text></svg>`)}`;

export async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const method = init.method ?? "GET";
  await new Promise((r) => setTimeout(r, 40));

  if (method !== "GET") return new Response(null, { status: 200 });
  if (url.includes("/users/authenticated")) return json({ id: 1, name: "valor_owner", displayName: "Valor" });
  if (url.includes("/groups/roles")) return json({ data: [{ group: { id: 4861395, name: "[Valor Designs]" }, role: { rank: 255 } }] });
  if (url.includes("/membership")) return json({ permissions: { groupEconomyPermissions: { manageItems: true, manageGroupGames: true, spendGroupFunds: true } } });
  if (url.includes("catalog.roblox.com/v2/search")) {
    return json({
      nextPageCursor: null,
      data: items.map((i) => ({ id: i.id, itemType: "Asset", assetType: i.assetType, name: i.name, price: i.price, priceStatus: i.onSale ? undefined : "Off Sale", collectibleItemId: `c-${i.id}` })),
    });
  }
  if (url.includes("revenue-split")) return json({ RevenueSplit: { creatorSplitPercentage: 70 } });
  if (url.includes("/universes?")) return json({ data: [{ id: 42, name: "Valor Hangout" }, { id: 43, name: "Valor Test Place" }], nextPageCursor: null });
  if (url.includes("/game-passes/creator")) {
    return json({ gamePasses: passes.map((p) => ({ gamePassId: p.gamePassId, name: p.name, isForSale: p.onSale, priceInformation: { defaultPriceInRobux: p.price, enabledFeatures: ["RegionalPricing"] }, isManagedPricingEnabled: p.gamePassId === 901 })), nextPageToken: "" });
  }
  if (url.includes("/developer-products/creator")) {
    return json({ developerProducts: products.map((p) => ({ productId: p.productId, name: p.name, isForSale: p.onSale, priceInformation: { defaultPriceInRobux: p.price, enabledFeatures: [] }, isManagedPricingEnabled: false })), nextPageToken: "" });
  }
  if (url.includes("thumbnails.roblox.com")) {
    const ids = (new URL(url).searchParams.get("assetIds") ?? new URL(url).searchParams.get("gamePassIds") ?? new URL(url).searchParams.get("developerProductIds") ?? new URL(url).searchParams.get("badgeIds") ?? "").split(",");
    return json({ data: ids.filter(Boolean).map((id) => ({ targetId: Number(id), state: "Completed", imageUrl: svgThumb(String(id).slice(-2), (Number(id) * 47) % 360) })) });
  }
  if (url.includes("/transactions")) return json({ data: transactions, nextPageCursor: null });
  if (url.includes("/currency")) return json({ robux: 48_210 });
  if (url.includes("badges.roblox.com")) return json({ data: badges, nextPageCursor: null });
  return json({ errors: [{ message: `No fake for ${url}` }] }, 404);
}
