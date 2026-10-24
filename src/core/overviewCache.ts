import type { Creator } from "../api/types";
import type { StorageLike } from "./history";

// The last account overview report, kept in the browser so opening the
// overview again shows it straight away. Only the totals are kept, each
// marked with when it was worked out; running the report again replaces them.

export const OVERVIEW_PERIODS = [7, 30, 90] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

export interface OverviewPeriodTotals {
  /** Earned in the period, the period before it, and pending in the period. */
  cur: number;
  prev: number;
  pending: number;
}

export interface OverviewRow {
  creator: Creator;
  owned: boolean;
  /** Recurring payout percentage for a group the user doesn't own; null when their role can't see it. */
  percent: number | null;
  periods: Partial<Record<OverviewPeriod, OverviewPeriodTotals>>;
  /** Earned since the first sale; null until loaded all the way back. */
  all: number | null;
  /** When the all-time total was worked out, if it was carried over from an earlier report. */
  allAsOf?: string;
  recentDone: boolean;
  balance: number | null;
  /** When these numbers were worked out (the sales are complete up to here). */
  asOf: string;
}

export interface SavedOverview {
  v: 1;
  rows: OverviewRow[];
}

const KEY = "overview";

export async function readOverview(storage: StorageLike): Promise<SavedOverview | null> {
  try {
    const saved = (await storage.get(KEY)) as SavedOverview | undefined;
    return saved?.v === 1 && Array.isArray(saved.rows) ? saved : null;
  } catch {
    return null;
  }
}

export async function writeOverview(storage: StorageLike, rows: OverviewRow[]): Promise<void> {
  try {
    await storage.set(KEY, { v: 1, rows } satisfies SavedOverview);
  } catch {
    // The report still shows; it just isn't there next time.
  }
}

export async function clearOverview(storage: StorageLike): Promise<void> {
  try {
    await storage.remove(KEY);
  } catch {
    // Nothing saved, or the browser won't say.
  }
}
