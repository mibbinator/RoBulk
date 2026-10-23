// Price rules: compute a new price for each selected item from its current one.

export type PriceOperation =
  | { kind: "set"; value: number }
  | { kind: "increasePercent"; value: number }
  | { kind: "decreasePercent"; value: number }
  | { kind: "increaseBy"; value: number }
  | { kind: "decreaseBy"; value: number };

/**
 * none: plain rounding to a whole number.
 * end9: nearest price ending in 9 (e.g. 47 -> 49, 52 -> 49).
 * end99: nearest price ending in 99 (e.g. 240 -> 199, 260 -> 299).
 * multiple5 / multiple10: nearest multiple.
 */
export type Rounding = "none" | "end9" | "end99" | "multiple5" | "multiple10";

export interface PriceRule {
  operation: PriceOperation;
  rounding: Rounding;
  min?: number;
  max?: number;
}

function applyOperation(current: number, op: PriceOperation): number {
  switch (op.kind) {
    case "set":
      return op.value;
    case "increasePercent":
      return current * (1 + op.value / 100);
    case "decreasePercent":
      return current * (1 - op.value / 100);
    case "increaseBy":
      return current + op.value;
    case "decreaseBy":
      return current - op.value;
  }
}

function nearestEnding(value: number, step: number, ending: number): number {
  // Candidates like ...9 or ...99 just below and above the value.
  const below = Math.floor((value - ending) / step) * step + ending;
  const above = below + step;
  const best = value - below <= above - value ? below : above;
  return best < ending ? ending : best;
}

export function round(value: number, rounding: Rounding): number {
  switch (rounding) {
    case "none":
      return Math.round(value);
    case "end9":
      return nearestEnding(value, 10, 9);
    case "end99":
      return value < 99 ? nearestEnding(value, 10, 9) : nearestEnding(value, 100, 99);
    case "multiple5":
      return Math.round(value / 5) * 5;
    case "multiple10":
      return Math.round(value / 10) * 10;
  }
}

/** Returns the new price, or null when the item has no price to work from. */
export function applyPriceRule(current: number | null, rule: PriceRule): number | null {
  if (current == null && rule.operation.kind !== "set") return null;
  let price = round(applyOperation(current ?? 0, rule.operation), rule.rounding);
  if (rule.min !== undefined) price = Math.max(price, rule.min);
  if (rule.max !== undefined) price = Math.min(price, rule.max);
  return Math.max(0, price);
}
