import { describe, expect, it } from "vitest";
import { applyPriceRule, round } from "./priceRules";

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
  ] as const)("%s rounds %d to %d", (mode, input, expected) => {
    expect(round(input, mode)).toBe(expected);
  });
});

describe("applyPriceRule", () => {
  it("raises by a percentage and rounds", () => {
    expect(applyPriceRule(100, { operation: { kind: "increasePercent", value: 15 }, rounding: "none" })).toBe(115);
    expect(applyPriceRule(100, { operation: { kind: "increasePercent", value: 15 }, rounding: "end9" })).toBe(119);
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
