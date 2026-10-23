import { describe, expect, it } from "vitest";
import type { SellableItem } from "../api/types";
import { toIdentifier, toLuaModule } from "./luaExport";

const pass = (id: number, name: string, price: number | null = 100): SellableItem => ({
  key: `gamePass:${id}`, kind: "gamePass", id, name, price, onSale: true, managedPricing: false, universeId: 1,
});
const product = (id: number, name: string, price = 10): SellableItem => ({
  key: `devProduct:${id}`, kind: "devProduct", id, name, price, onSale: true, managedPricing: false, universeId: 1,
});

describe("toIdentifier", () => {
  it("makes valid, unique Lua identifiers", () => {
    const taken = new Set<string>();
    expect(toIdentifier("Donate 100 Robux!", taken)).toBe("Donate100Robux");
    expect(toIdentifier("donate 100 robux", taken)).toBe("Donate100Robux_2");
    expect(toIdentifier("2x Coins", taken)).toBe("_2xCoins");
    expect(toIdentifier("🔥", taken)).toBe("Item");
    expect(toIdentifier("end", taken)).toBe("End");
  });
});

describe("toLuaModule", () => {
  const items = [pass(11, "VIP"), pass(12, "Double XP"), product(21, "100 Coins", 25)];

  it("exports ids grouped by type", () => {
    expect(toLuaModule(items, { experienceName: "My Game", includePrices: false, date: new Date("2026-10-23") })).toBe(
      [
        "-- My Game: monetization ids (exported 2026-10-23)",
        "-- Re-export after adding or removing passes/products.",
        "",
        "return {",
        "\tGamePasses = {",
        "\t\tDoubleXP = 12, -- Double XP",
        "\t\tVIP = 11, -- VIP",
        "\t},",
        "\tDeveloperProducts = {",
        "\t\t_100Coins = 21, -- 100 Coins",
        "\t},",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("can include prices", () => {
    expect(toLuaModule(items, { experienceName: "G", includePrices: true })).toContain("_100Coins = { Id = 21, Price = 25 },");
  });
});
