# RoBulk

Bulk tools for the Roblox Creator Dashboard. Price, rename, schedule and put items on or off sale by the dozen instead of one at a time, see what your store and games actually earn, and spin up game passes and developer products from templates.

Works for clothing and UGC sellers and for game developers, on items owned by you or by your groups.

## What it does

**Items**
- Every avatar item you own (classic shirts, pants and t-shirts, accessories, layered clothing, heads) plus the game passes and developer products of whichever experience you pick, grouped by category
- Checkboxes, *Select all* per category, shift-click ranges, search, on/off-sale filter, sorting by price or best sellers
- Bulk actions: set price, put on sale, take off sale, price rules (raise or lower by % or Robux, round to prices ending in 9 or 99, min/max), scheduled sales, rename and description templates, regional pricing and managed pricing on/off
- Shows what you keep from each sale at the current price
- Every change is staged first, with old → new values on each row, and only sent when you hit Save
- Saves go out one item at a time with pacing, retry on rate limits, and per-row results so failures can be fixed and retried
- Spreadsheet export/import (.csv) and a Lua export of pass/product ids ready to drop into a ModuleScript

**Earnings report**
- Earned, sales, average per sale, unique buyers, pending Robux and current balance, compared with the previous period
- Daily earnings, earnings by category, top items, sales per day and top buyers, for the last 7, 30 or 90 days
- Per-item sales and earnings from the Items tab
- Every chart has a table view, and the report exports to .csv

**Create & copy**
- Bulk-create developer products or game passes from templates (donation tiers, currency packs, starter passes) or a numbered series, with one icon for all of them
- Copy passes and products from one experience to another, icons included

**Badges**
- Enable, disable and rename badges in bulk, with award counts and win rates

**History**
- A snapshot of your prices and sale status is taken automatically once a day and before every save, so you can put everything back the way it was (handy when a lapsed Premium subscription takes a group's clothing off sale)
- Activity log of everything saved through RoBulk, exportable to .csv

Only groups where your role can manage items or experiences show up in the creator picker, and earnings only appear if you can view the group's revenue.

## Installing

Store listings are on the way. Until then:

1. `npm install` and `npm run build`
2. Chrome / Edge: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose `dist`
3. Firefox: run `npm run package`, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `dist-firefox/manifest.json`

Then open [create.roblox.com](https://create.roblox.com/dashboard/creations) and click **Bulk Edit** in the bottom-right corner.

## Development

```sh
npm run dev        # rebuild dist/ on every change
npm test           # unit + UI tests
npm run preview    # the panel on fake data: open dist-preview/index.html
npm run package    # store zips in release/ for Chrome and Firefox
npm run icons      # regenerate public/icons
```

`npm run preview` is the quickest way to work on the UI without touching a real account. Add `?tab=earnings` (or `create`, `badges`, `history`) and `&theme=light` to the URL.

### How saving works

Roblox has no bulk endpoint, so RoBulk sends one request per item through your existing dashboard session.

- **Avatar items** are listed with the public catalog search. Before saving, RoBulk reads the item's full sale settings (`GET itemconfiguration.roblox.com/v1/items`) and sends them back unchanged apart from what you edited (`PATCH /v1/collectibles/{collectibleItemId}`), because that endpoint replaces every setting at once. Renames use `/v1/collectibles/update-item-display-information`. Limited items are skipped.
- **Game passes and developer products** use Roblox's documented [game pass](https://create.roblox.com/docs/cloud/reference/features/game-passes) and [developer product](https://create.roblox.com/docs/cloud/reference/features/developer-products) endpoints, sending only the fields that changed.
- **Badges** use `PATCH badges.roblox.com/v1/badges/{id}`.
- **Earnings** come from your sale transactions (`economy.roblox.com/v2/{users|groups}/{id}/transactions`). Very busy stores are capped at the latest 6,000 sales per load.

## Privacy

RoBulk has no servers, analytics or accounts. It only talks to Roblox, using the login you already have, and keeps snapshots and the activity log in your browser's extension storage. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE) © 2026 mibbinator. Use it, change it, ship it, just keep the copyright notice and license with any copy.

## Disclaimer

RoBulk is not affiliated with, endorsed by, or sponsored by Roblox Corporation.
