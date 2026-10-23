// Builds store-ready zips from dist/ (run `npm run build` first):
//   release/robulk-chrome-<version>.zip   Chrome Web Store / Edge Add-ons
//   release/robulk-firefox-<version>.zip  addons.mozilla.org
// and an unpacked dist-firefox/ for about:debugging.

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const { version } = manifest;

// Firefox runs background scripts as event pages rather than service workers.
const firefoxManifest = {
  ...manifest,
  background: { scripts: manifest.background.scripts ?? [manifest.background.service_worker] },
  browser_specific_settings: {
    gecko: {
      id: "robulk@robulk.dev",
      strict_min_version: "121.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
};

rmSync("dist-firefox", { recursive: true, force: true });
cpSync("dist", "dist-firefox", { recursive: true });
writeFileSync("dist-firefox/manifest.json", JSON.stringify(firefoxManifest, null, 2) + "\n");

function collect(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).replace(/\\/g, "/")] = readFileSync(path);
    }
  };
  walk(dir);
  return files;
}

mkdirSync("release", { recursive: true });
for (const [target, dir] of [
  ["chrome", "dist"],
  ["firefox", "dist-firefox"],
]) {
  const out = `release/robulk-${target}-${version}.zip`;
  writeFileSync(out, zipSync(collect(dir), { level: 9 }));
  console.log(`${out}  (${(statSync(out).size / 1024).toFixed(1)} KB)`);
}
