import { describe, expect, it } from "vitest";
import type { SellableItem } from "../api/types";
import { csvToPatches, parseCsv, toCsv } from "./csv";
import { setEdits } from "./edits";

const items: SellableItem[] = [
  { key: "avatar:1", kind: "avatar", id: 1, assetType: 11, name: 'Suit, "Orange"', description: "Line 1\nLine 2", price: 5, onSale: false },
  { key: "gamePass:7", kind: "gamePass", id: 7, universeId: 3, name: "VIP", price: 100, onSale: true, managedPricing: false },
];

describe("csv", () => {
  it("exports a header and escaped rows", () => {
    const csv = toCsv(items);
    expect(csv.split("\r\n")[0]).toBe("type,id,category,name,price,on_sale,managed_pricing,description");
    expect(csv).toContain('avatar,1,Classic Shirts,"Suit, ""Orange""",5,no,,"Line 1\nLine 2"');
    expect(csv).toContain("game_pass,7,Game Passes,VIP,100,yes,no,");
  });

  it("parses what it exports", () => {
    const rows = parseCsv(toCsv(items));
    expect(rows[1][3]).toBe('Suit, "Orange"');
    expect(rows[1][7]).toBe("Line 1\nLine 2");
    expect(rows).toHaveLength(3);
  });

  it("round-trips without staging any changes", () => {
    const { patches, warnings } = csvToPatches(toCsv(items), items);
    expect(warnings).toEqual([]);
    expect(setEdits(new Map(), patches).size).toBe(0);
  });

  it("stages edited cells and warns about bad rows", () => {
    const csv = [
      "type,id,name,price,on_sale",
      "avatar,1,New name,10,yes",
      "game_pass,7,VIP,abc,no",
      "avatar,999,Ghost,5,yes",
    ].join("\n");

    const { patches, warnings } = csvToPatches(csv, items);
    const edits = setEdits(new Map(), patches);

    expect(edits.get("avatar:1")).toEqual({ name: "New name", price: 10, onSale: true });
    expect(edits.get("gamePass:7")).toEqual({ onSale: false });
    expect(warnings).toEqual([
      'Row 3: "abc" isn\'t a valid price.',
      "Row 4: no loaded item matches this type and id, so it was skipped.",
    ]);
  });

  it("explains a file without an id column", () => {
    expect(csvToPatches("name,price\nx,5", items).warnings[0]).toMatch(/"id" column/);
  });
});
