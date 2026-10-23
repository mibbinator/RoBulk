# RoBulk

Bulk sale and pricing tools for the Roblox Creator Dashboard.

RoBulk is a Chrome extension (Manifest V3) that adds a **Bulk Edit** panel to the Creator Dashboard so creators can put many items on or off sale and change their prices at once, instead of one item at a time.

## Planned support

- Classic clothing: Shirts, Pants, T-Shirts
- Other avatar items (accessories / UGC)
- Game Passes and Developer Products
- Items owned by groups and by personal accounts

## Features (planned)

- Checkbox selection per item, plus **Select all** per category
- Bulk actions: set price, put on sale, take off sale, toggle managed pricing (passes/products)
- Changes are saved to Roblox one item at a time with pacing; each row reports success or failure, and failed rows can be retried

## Development

```sh
npm install
npm run build      # typecheck + build into dist/
npm run dev        # rebuild on every change
npm test           # unit tests
```

Load it in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist` folder. After rebuilding, click the reload icon on the RoBulk card and refresh the Creator Dashboard tab.

### How saving works

Roblox has no bulk endpoint, so RoBulk sends one request per item, about one every 0.75s, retrying if Roblox rate-limits it.

- Items are listed with the public catalog search (`catalog.roblox.com/v2/search/items/details` with `IncludeNotForSale=true`), which also returns each item's `collectibleItemId`.
- Avatar item sale status and price are saved with `PATCH itemconfiguration.roblox.com/v1/collectibles/{collectibleItemId}` (`saleStatus` 0 = on sale, 1 = off sale), the same call the Creator Dashboard makes.

## Privacy

RoBulk has no servers, analytics or accounts. It talks only to Roblox, using your existing Creator Dashboard login.

## Disclaimer

RoBulk is not affiliated with, endorsed by, or sponsored by Roblox Corporation.
