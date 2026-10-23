import { render } from "preact";
import panelsCss from "../src/ui/panels.css?inline";
import baseCss from "../src/ui/styles.css?inline";
import { Shell, type TabId } from "../src/ui/Shell";
import { runDemo } from "./demos";
import { fakeFetch } from "./fakeRoblox";

// Preview page: the real panel running against fake data.
//   npm run preview, then open dist-preview/index.html
//   ?tab=earnings|create|badges|history  ?theme=light
//   ?embed=1     panel only, transparent background (for store screenshots)
//   ?demo=name   click through to a state, see demos.ts
//   ?universeId= preselect an experience
//   ?unpublished show the unpublished clothing warning
//   ?slowSales   load sales slowly, a page at a time

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

const root = document.getElementById("app")!;
root.className = "rb-root";
root.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
render(
  <Shell onClose={() => {}} initialTab={(params.get("tab") as TabId) ?? "items"} initialUniverseId={params.has("universeId") ? Number(params.get("universeId")) : null} />,
  root,
);

const demo = params.get("demo");
if (demo) runDemo(demo, root);
