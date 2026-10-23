// Refreshes the preview page's sample store from a real group's public
// catalog (names, prices, sale status and thumbnails). Thumbnail URLs from
// Roblox's CDN expire after a few months, so re-run this before regenerating
// store screenshots.
//
//   node scripts/fetch-preview-data.mjs [groupId]

import { mkdirSync, writeFileSync } from "node:fs";

const groupId = Number(process.argv[2] ?? 4861395);
const items = [];
let cursor = "";
for (;;) {
  const params = new URLSearchParams({ CreatorType: "2", CreatorTargetId: String(groupId), IncludeNotForSale: "true", SortType: "3", Limit: "120" });
  if (cursor) params.set("Cursor", cursor);
  const page = await (await fetch(`https://catalog.roblox.com/v2/search/items/details?${params}`)).json();
  if (page.errors) throw new Error(JSON.stringify(page.errors));
  items.push(...page.data.filter((i) => i.itemType === "Asset"));
  if (!page.nextPageCursor) break;
  cursor = page.nextPageCursor;
}

const thumbs = {};
for (let i = 0; i < items.length; i += 100) {
  const ids = items.slice(i, i + 100).map((x) => x.id).join(",");
  const res = await (await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=150x150&format=Png`)).json();
  for (const t of res.data) if (t.imageUrl) thumbs[t.targetId] = t.imageUrl;
}

const group = await (await fetch(`https://groups.roblox.com/v1/groups/${groupId}`)).json();
const fixture = {
  group: { id: groupId, name: group.name },
  owner: { id: group.owner?.userId, name: group.owner?.username },
  items: items.map((i) => ({
    id: i.id,
    assetType: i.assetType,
    name: i.name,
    price: i.price ?? i.lowestPrice ?? 5,
    onSale: i.priceStatus !== "Off Sale",
    thumb: thumbs[i.id] ?? null,
  })),
};

mkdirSync("preview/fixtures", { recursive: true });
writeFileSync("preview/fixtures/store.json", JSON.stringify(fixture, null, 1) + "\n");
console.log(`${fixture.group.name} (owner ${fixture.owner.name}): ${fixture.items.length} items written to preview/fixtures/store.json`);
