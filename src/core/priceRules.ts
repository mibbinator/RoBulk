// Price rules: compute a new price for each selected item from its current one.

export type PriceOperation =
  | { kind: "set"; value: number }
  | { kind: "increasePercent"; value: number }
  | { kind: "decreasePercent"; value: number }
  | { kind: "increaseBy"; value: number }
  | { kind: "decreaseBy"; value: number };

/**
 * none: whole Robux.
 * end9: a price ending in 9 (49, 99).
 * end99: a price ending in 99 (199, 299), or in 9 below 99.
 * multiple5 / multiple10: a multiple of 5 or 10.
 */
export type Rounding = "none" | "end9" | "end99" | "multiple5" | "multiple10";

/** Raises round up and discounts round down, so a raise never lowers a price. */
export type RoundDirection = "nearest" | "up" | "down";

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

function directionFor(op: PriceOperation): RoundDirection {
  if (op.kind === "increasePercent" || op.kind === "increaseBy") return "up";
  if (op.kind === "decreasePercent" || op.kind === "decreaseBy") return "down";
  return "nearest";
}

/** Snaps to values of the form k * step + offset (offset < step). */
function snap(value: number, step: number, offset: number, direction: RoundDirection): number {
  const below = Math.floor((value - offset) / step) * step + offset;
  const above = below === value ? below : below + step;
  const pickAbove = direction === "up" || (direction === "nearest" && above - value < value - below);
  const result = pickAbove ? above : below;
  return result < offset ? offset : result;
}

export function round(value: number, rounding: Rounding, direction: RoundDirection = "nearest"): number {
  // Tolerate float noise like 11.000000000000002 before rounding up.
  const v = Math.round(value * 1e6) / 1e6;
  switch (rounding) {
    case "none":
      return direction === "up" ? Math.ceil(v) : direction === "down" ? Math.floor(v) : Math.round(v);
    case "end9":
      return snap(v, 10, 9, direction);
    case "end99":
      return v <= 99 ? snap(v, 10, 9, direction) : snap(v, 100, 99, direction);
    case "multiple5":
      return snap(v, 5, 0, direction);
    case "multiple10":
      return snap(v, 10, 0, direction);
  }
}

/** Returns the new price, or null when the item has no price to work from. */
export function applyPriceRule(current: number | null, rule: PriceRule): number | null {
  if (current == null && rule.operation.kind !== "set") return null;
  let price = round(applyOperation(current ?? 0, rule.operation), rule.rounding, directionFor(rule.operation));
  if (rule.min !== undefined) price = Math.max(price, rule.min);
  if (rule.max !== undefined) price = Math.min(price, rule.max);
  return Math.max(0, price);
}
