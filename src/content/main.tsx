import { render } from "preact";
import { App } from "../ui/App";
import { RobloxSiteApp } from "../ui/RobloxSiteApp";
import panelsCss from "../ui/panels.css?inline";
import baseCss from "../ui/styles.css?inline";

// Mount RoBulk inside a shadow root so the page's styles and ours can't
// affect each other. On the Creator Dashboard that's the whole extension; on
// www.roblox.com it's only the off-sale alarm.
function mount() {
  if (document.getElementById("robulk-host")) return;
  const host = document.createElement("div");
  host.id = "robulk-host";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = baseCss + panelsCss;
  shadow.appendChild(style);

  const root = document.createElement("div");
  shadow.appendChild(root);
  render(location.hostname === "create.roblox.com" ? <App /> : <RobloxSiteApp />, root);
}

mount();
