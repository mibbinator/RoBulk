import type { SellableItem } from "../api/types";

// Generates a ModuleScript-ready Lua table of game pass and developer product
// ids, so developers can stop copying ids out of the dashboard by hand.

export interface LuaExportOptions {
  experienceName: string;
  includePrices: boolean;
  date?: Date;
}

/** Turns "Donate 100 Robux!" into "Donate100Robux"; keeps names valid and unique. */
export function toIdentifier(name: string, taken: Set<string>): string {
  const words = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Item";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (LUA_KEYWORDS.has(id)) id = `${id}_`;
  let unique = id;
  for (let n = 2; taken.has(unique); n++) unique = `${id}_${n}`;
  taken.add(unique);
  return unique;
}

const LUA_KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", "continue", "type", "export",
]);

function section(title: string, items: SellableItem[], includePrices: boolean): string[] {
  const taken = new Set<string>();
  const lines = [`\t${title} = {`];
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    const key = toIdentifier(item.name, taken);
    const comment = ` -- ${item.name.replace(/[\r\n]+/g, " ")}`;
    lines.push(
      includePrices
        ? `\t\t${key} = { Id = ${item.id}, Price = ${item.price ?? "nil"} },${comment}`
        : `\t\t${key} = ${item.id},${comment}`,
    );
  }
  lines.push("\t},");
  return lines;
}

export function toLuaModule(items: SellableItem[], { experienceName, includePrices, date = new Date() }: LuaExportOptions): string {
  const passes = items.filter((i) => i.kind === "gamePass");
  const products = items.filter((i) => i.kind === "devProduct");
  const stamp = date.toISOString().slice(0, 10);
  return [
    `-- ${experienceName.replace(/[\r\n]+/g, " ")}: monetization ids (exported ${stamp})`,
    "-- Re-export after adding or removing passes/products.",
    "",
    "return {",
    ...section("GamePasses", passes, includePrices),
    ...section("DeveloperProducts", products, includePrices),
    "}",
    "",
  ].join("\n");
}
