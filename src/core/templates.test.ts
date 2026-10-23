import { describe, expect, it } from "vitest";
import { TEMPLATES, buildNumberedSeries, validateDraft } from "./templates";

describe("templates", () => {
  it("builds valid drafts for every template", () => {
    for (const t of TEMPLATES) {
      const drafts = t.build();
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.map(validateDraft).filter(Boolean)).toEqual([]);
    }
  });

  it("builds a numbered series", () => {
    expect(
      buildNumberedSeries({ nameTemplate: "Crate {n}", description: "Costs {price}", count: 3, startPrice: 50, priceStep: 25, onSale: false }),
    ).toEqual([
      { name: "Crate 1", description: "Costs 50", price: 50, onSale: false },
      { name: "Crate 2", description: "Costs 75", price: 75, onSale: false },
      { name: "Crate 3", description: "Costs 100", price: 100, onSale: false },
    ]);
  });

  it("caps a series at 100 items", () => {
    expect(buildNumberedSeries({ nameTemplate: "x{n}", description: "", count: 500, startPrice: 1, priceStep: 0, onSale: true })).toHaveLength(100);
  });

  it("validates drafts", () => {
    expect(validateDraft({ name: " ", description: "", price: 5, onSale: true })).toBe("Needs a name");
    expect(validateDraft({ name: "x".repeat(51), description: "", price: 5, onSale: true })).toMatch(/50/);
    expect(validateDraft({ name: "ok", description: "", price: 2.5, onSale: true })).toMatch(/whole/);
  });
});
