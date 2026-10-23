// Renders Chrome Web Store / AMO images with headless Chrome from the
// preview page (the real panel on fake data):
//   store/screenshots/*.png  1280x800
//   store/promo-440x280.png
//   store/marquee-1400x560.png
//
//   npm run store-assets
// Set CHROME=/path/to/chrome if it isn't found automatically.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("Couldn't find Chrome. Set CHROME=/path/to/chrome.");

const SCREENSHOTS = [
  {
    file: "1-restock.png",
    q: "demo=restock",
    title: "Put your whole store back on sale in one go",
    sub: "Select by category, stage the changes and review them. Old values stay visible until you hit Save.",
  },
  {
    file: "2-earnings.png",
    q: "tab=earnings",
    title: "See what every item actually earns",
    sub: "Daily earnings, best sellers, top buyers and a category breakdown for the last 7, 30 or 90 days.",
  },
  {
    file: "3-price-rules.png",
    q: "demo=priceRule",
    title: "Price rules, sale schedules and bulk renames",
    sub: "Raise a whole category by 50%, round prices the way you like, and preview it all before saving.",
  },
  {
    file: "4-create.png",
    q: "tab=create&demo=template",
    title: "Game passes and developer products from templates",
    sub: "Donation tiers, currency packs or a numbered series in one batch, then copy them to your other games.",
  },
  {
    file: "5-badges.png",
    q: "tab=badges",
    title: "Manage badges without all the clicking",
    sub: "Enable, disable and rename badges in bulk, and see which ones players actually earn.",
  },
];

function shoot(page, out, [width, height]) {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=25000",
    `--screenshot=${resolve(out)}`,
    page,
  ], { stdio: "ignore" });
  console.log(out);
}

// groupId opens the panel on the sample group, like a store owner would.
const url = (file, params) => `${pathToFileURL(resolve(file)).href}${params ? `?${new URLSearchParams(params)}` : ""}`;

mkdirSync("store/screenshots", { recursive: true });
for (const s of SCREENSHOTS) shoot(url("store/frame.html", { title: s.title, sub: s.sub, q: `groupId=4861395&${s.q}` }), `store/screenshots/${s.file}`, [1280, 800]);
shoot(url("store/promo.html"), "store/promo-440x280.png", [440, 280]);
shoot(url("store/marquee.html"), "store/marquee-1400x560.png", [1400, 560]);
