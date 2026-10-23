import { transactionItemKey, type SaleTransaction } from "./earnings";
import type { LogEntry, Snapshot } from "./history";

// Experimental: how an item sold before and after its last price change.
// Prices come from RoBulk's change log (exact time, for changes saved through
// RoBulk) and its snapshots (daily, so a change made on the dashboard is only
// known to within a day). Sales in equal-length windows either side of the
// change are compared per day.

export interface PriceChange {
  at: Date;
  from: number;
  to: number;
  /** True when it's only known from snapshots, so the time is approximate. */
  approximate: boolean;
}

/** The item's most recent price change RoBulk knows of. */
export function lastPriceChange(itemKey: string, snapshots: Snapshot[], log: LogEntry[]): PriceChange | null {
  const points: { at: Date; price: number; exact: boolean }[] = [];
  for (const s of snapshots) {
    const item = s.items.find((i) => i.key === itemKey);
    if (item?.price != null) points.push({ at: new Date(s.takenAt), price: item.price, exact: false });
  }
  for (const e of log) {
    const change = e.changes.price;
    if (e.ok && e.itemKey === itemKey && typeof change?.to === "number") points.push({ at: new Date(e.at), price: change.to, exact: true });
  }
  points.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i].price !== points[i - 1].price) return { at: points[i].at, from: points[i - 1].price, to: points[i].price, approximate: !points[i].exact };
  }
  return null;
}

export interface Window {
  days: number;
  sales: number;
  robux: number;
  salesPerDay: number;
  robuxPerDay: number;
}

export interface PriceImpact {
  change: PriceChange;
  before: Window;
  after: Window;
  /** Sales go back far enough to cover the "before" window. */
  needsSalesSince: Date;
}

const DAY = 86_400_000;

/** Compares up to `maxDays` either side of the change, both windows the same length. */
export function priceImpact(itemKey: string, change: PriceChange, sales: SaleTransaction[], now: Date, maxDays = 30): PriceImpact | null {
  const days = Math.min(maxDays, (now.getTime() - change.at.getTime()) / DAY);
  if (days < 1) return null; // too soon to say anything
  const changed = change.at.getTime();
  const window = (from: number, to: number): Window => {
    let count = 0;
    let robux = 0;
    for (const s of sales) {
      const at = new Date(s.created).getTime();
      if (at < from || at >= to || transactionItemKey(s) !== itemKey) continue;
      count++;
      robux += s.robux;
    }
    return { days, sales: count, robux, salesPerDay: count / days, robuxPerDay: robux / days };
  };
  return {
    change,
    before: window(changed - days * DAY, changed),
    after: window(changed, changed + days * DAY),
    needsSalesSince: new Date(changed - days * DAY),
  };
}
