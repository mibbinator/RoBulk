import type { SaleTransaction } from "./earnings";

// When sales come in: a week of local days by hour, for the experimental
// "Best times to sell" chart.

/** Monday first, matching how most people read a week. */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface SalesTiming {
  /** [weekday 0 = Monday][hour 0-23] */
  sales: number[][];
  robux: number[][];
  max: number;
  busiest: { day: number; hour: number; sales: number } | null;
}

export function salesTiming(transactions: SaleTransaction[], from: Date, to: Date): SalesTiming {
  const sales = WEEKDAYS.map(() => new Array<number>(24).fill(0));
  const robux = WEEKDAYS.map(() => new Array<number>(24).fill(0));
  const start = from.getTime();
  const end = to.getTime();
  for (const t of transactions) {
    const at = new Date(t.created);
    if (at.getTime() < start || at.getTime() > end) continue;
    const day = (at.getDay() + 6) % 7;
    sales[day][at.getHours()]++;
    robux[day][at.getHours()] += t.robux;
  }
  let busiest: SalesTiming["busiest"] = null;
  sales.forEach((hours, day) =>
    hours.forEach((n, hour) => {
      if (n > 0 && (!busiest || n > busiest.sales)) busiest = { day, hour, sales: n };
    }),
  );
  return { sales, robux, max: Math.max(0, ...sales.flat()), busiest };
}

/** "3 PM", in the viewer's 12- or 24-hour style. */
export const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
