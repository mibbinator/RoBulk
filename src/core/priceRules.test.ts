import { describe, expect, it } from "vitest";
import { applyPriceRule, round, type PriceRule, type Rounding } from "./priceRules";

describe("round", () => {
  it.each([
    ["none", 47.6, 48],
    ["end9", 47, 49],
    ["end9", 52, 49],
    ["end9", 3, 9],
    ["end99", 240, 199],
    ["end99", 260, 299],
    ["end99", 55, 59],
    ["multiple5", 22, 20],
    ["multiple10", 26, 30],
  ] as const)("%s rounds %d to the nearest %d", (mode, input, expected) => {
    expect(round(input, mode)).toBe(expected);
  });

  it.each([
    ["none", 11.2, "up", 12],
    ["none", 11.8, "down", 11],
    ["end9", 12, "up", 19],
    ["end9", 52, "up", 59],
    ["end9", 52, "down", 49],
    ["end9", 49, "up", 49],
    ["end99", 120, "up", 199],
    ["end99", 120, "down", 99],
    ["end99", 60, "up", 69],
    ["multiple5", 21, "up", 25],
    ["multiple10", 29, "down", 20],
  ] as const)("%s rounds %d %s to %d", (mode, input, direction, expected) => {
    expect(round(input, mode as Rounding, direction)).toBe(expected);
  });
});

describe("applyPriceRule", () => {
  const raise = (value: number, rounding: Rounding): PriceRule => ({ operation: { kind: "increasePercent", value }, rounding });

  it("raises by a percentage and rounds", () => {
    expect(applyPriceRule(100, raise(15, "none"))).toBe(115);
    expect(applyPriceRule(100, raise(15, "end9"))).toBe(119);
  });

  it("never lowers a price when raising it", () => {
    // 10 + 20% = 12, and the nearest price ending in 9 is 9.
    expect(applyPriceRule(10, raise(20, "end9"))).toBe(19);
    for (const rounding of ["none", "end9", "end99", "multiple5", "multiple10"] as const) {
      for (const price of [5, 10, 15, 49, 99, 250]) expect(applyPriceRule(price, raise(1, rounding))!).toBeGreaterThanOrEqual(price);
    }
  });

  it("never raises a price when discounting it", () => {
    for (const rounding of ["none", "end9", "end99", "multiple5", "multiple10"] as const) {
      for (const price of [19, 49, 99, 250]) {
        expect(applyPriceRule(price, { operation: { kind: "decreasePercent", value: 5 }, rounding })!).toBeLessThanOrEqual(price);
      }
    }
  });

  it("discounts and clamps to a minimum", () => {
    expect(applyPriceRule(10, { operation: { kind: "decreasePercent", value: 80 }, rounding: "none", min: 5 })).toBe(5);
  });

  it("clamps to a maximum", () => {
    expect(applyPriceRule(900, { operation: { kind: "increaseBy", value: 500 }, rounding: "none", max: 1000 })).toBe(1000);
  });

  it("never goes below zero", () => {
    expect(applyPriceRule(5, { operation: { kind: "decreaseBy", value: 50 }, rounding: "none" })).toBe(0);
  });

  it("sets a price even when there wasn't one", () => {
    expect(applyPriceRule(null, { operation: { kind: "set", value: 25 }, rounding: "none" })).toBe(25);
    expect(applyPriceRule(null, { operation: { kind: "increasePercent", value: 10 }, rounding: "none" })).toBeNull();
  });
});
