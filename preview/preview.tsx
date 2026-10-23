import { render } from "preact";
import panelsCss from "../src/ui/panels.css?inline";
import baseCss from "../src/ui/styles.css?inline";
import { memoryStorage } from "../src/core/history";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { AccountOverview } from "../src/ui/AccountOverview";
import { Shell, type TabId } from "../src/ui/Shell";
import { fallbackStorage } from "../src/ui/workspace";
import { runDemo } from "./demos";
import store from "./fixtures/store.json";
import { fakeFetch } from "./fakeRoblox";

// Preview page: the real panel running against fake data.
//   npm run preview, then open dist-preview/index.html
//   ?tab=earnings|create|badges|history  ?theme=light
//   ?embed=1     panel only, transparent background (for store screenshots)
//   ?demo=name   click through to a state, see demos.ts
//   ?universeId= preselect an experience
//   ?unpublished show the unpublished clothing warning
//   ?slowSales   load sales slowly, a page at a time
//   ?overview    the Account Overview instead of the panel
//   ?experimental  switch on the experimental features
//   ?designers   sample designers on the Payouts tab (with ?tab=payouts)

window.fetch = fakeFetch as typeof fetch;

const params = new URLSearchParams(location.search);
const style = document.createElement("style");
style.textContent = baseCss + panelsCss;
if (params.has("embed")) {
  style.textContent += `
    html, body { background: transparent !important; }
    .rb-overlay { background: transparent; padding: 0; }
    .rb-panel { width: 100%; height: 100%; }
  `;
}
document.head.appendChild(style);

// One pretend store for the whole page, seeded with whatever the URL asks for.
// (It's in memory, so these are done before the panel first reads them.)
const storage = (fallbackStorage.current = memoryStorage());
void storage.set("settings", { ...DEFAULT_SETTINGS, bestTimes: params.has("experimental"), priceImpact: params.has("experimental") });
if (params.has("designers")) {
  const groupId = params.get("groupId") ?? "4861395";
  const itemKeys = (n: number, from: number) => store.items.slice(from, from + n).map((i) => `avatar:${i.id}`);
  void storage.set(`payouts:Group:${groupId}`, {
    designers: [
      { userId: 156, name: "builderman", share: 30, itemKeys: itemKeys(12, 0), paidThrough: null },
      { userId: 261, name: "Shedletsky", share: 25, itemKeys: itemKeys(8, 12), paidThrough: null },
    ],
    paid: [],
  });
}

const root = document.getElementById("app")!;
root.className = "rb-root";
root.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
render(
  params.has("overview") ? (
    <AccountOverview onClose={() => {}} onOpenCreator={() => {}} />
  ) : (
    <Shell onClose={() => {}} initialTab={(params.get("tab") as TabId) ?? "items"} initialUniverseId={params.has("universeId") ? Number(params.get("universeId")) : null} />
  ),
  root,
);

const demo = params.get("demo");
if (demo) runDemo(demo, root);
