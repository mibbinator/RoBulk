import type { StorageLike } from "./history";

// Features the user can switch off in the Options tab. Saved in the browser
// alongside everything else, so they apply on every page and every visit.

export interface Settings {
  /** Start loading sales as soon as RoBulk opens. */
  backgroundSales: boolean;
  /** Keep loaded sales in the browser so later visits only fetch new ones. */
  rememberSales: boolean;
  /** The most sales kept in the browser per account or group; null for no limit. */
  maxStoredSales: number | null;
  /** Keep the last account overview report, so it shows straight away next time. */
  rememberOverview: boolean;
  /** Look up Roblox's share for each price to show "you get R$…". */
  perSaleEarnings: boolean;
  /** Take a snapshot of prices and sale status once a day, for undo. */
  dailySnapshots: boolean;
  /** Warn when items go off sale without RoBulk doing it. */
  offSaleAlarm: boolean;
  /** Count new sales since the Earnings report was last opened, on the sidebar entry. */
  newSalesBadge: boolean;
  /** Experimental: a day-by-hour chart of when sales happen. */
  bestTimes: boolean;
  /** Experimental: compare an item's sales before and after its last price change. */
  priceImpact: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  backgroundSales: true,
  rememberSales: true,
  maxStoredSales: 100_000,
  rememberOverview: true,
  perSaleEarnings: true,
  dailySnapshots: true,
  offSaleAlarm: true,
  newSalesBadge: true,
  bestTimes: false,
  priceImpact: false,
};

const KEY = "settings";

export async function readSettings(storage: StorageLike): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...((await storage.get(KEY)) as Partial<Settings> | undefined) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function writeSettings(storage: StorageLike, settings: Settings): Promise<void> {
  try {
    await storage.set(KEY, settings);
  } catch {
    // Unsaved settings still apply until the page is closed.
  }
}
