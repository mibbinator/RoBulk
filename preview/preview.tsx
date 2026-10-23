import { render } from "preact";
import panelsCss from "../src/ui/panels.css?inline";
import baseCss from "../src/ui/styles.css?inline";
import { Shell, type TabId } from "../src/ui/Shell";
import { fakeFetch } from "./fakeRoblox";

// Preview page: the real panel running against fake data.
//   npm run preview, then open dist-preview/index.html
//   ?tab=earnings|create|badges|history  ?theme=light

window.fetch = fakeFetch as typeof fetch;

const params = new URLSearchParams(location.search);
const style = document.createElement("style");
style.textContent = baseCss + panelsCss;
document.head.appendChild(style);

const root = document.getElementById("app")!;
root.className = "rb-root";
root.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
render(<Shell onClose={() => {}} initialTab={(params.get("tab") as TabId) ?? "items"} />, root);
