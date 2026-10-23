import { render } from "preact";
import { App } from "../ui/App";
import panelsCss from "../ui/panels.css?inline";
import baseCss from "../ui/styles.css?inline";

// Mount RoBulk inside a shadow root so the Creator Dashboard's styles and
// ours can't affect each other.
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
  render(<App />, root);
}

mount();
