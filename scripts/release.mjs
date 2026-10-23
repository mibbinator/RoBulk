// Bumps the version, commits, tags and pushes. The tag push starts the
// Release workflow, which tests, packages and publishes to the stores.
//
//   npm run release -- patch      1.0.0 -> 1.0.1
//   npm run release -- minor      1.0.0 -> 1.1.0
//   npm run release -- 2.0.0

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const bump = process.argv[2];
if (!bump) {
  console.error("Usage: npm run release -- <patch|minor|major|x.y.z>");
  process.exit(2);
}
if (git("status", "--porcelain")) {
  console.error("Commit or stash your changes first; a release should be exactly what's on main.");
  process.exit(1);
}
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
  console.error("Releases are cut from main.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : bump === "patch" ? `${major}.${minor}.${patch + 1}` : bump;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`"${bump}" isn't patch, minor, major or a version like 1.2.3.`);
  process.exit(2);
}

for (const file of ["package.json", "public/manifest.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = next;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

git("add", "package.json", "package-lock.json", "public/manifest.json");
git("commit", "-m", `Release v${next}`);
git("tag", "-a", `v${next}`, "-m", `v${next}`);
git("push", "--atomic", "origin", "main", `v${next}`);
console.log(`Released v${next}. Follow it at https://github.com/mibbinator/RoBulk/actions`);
