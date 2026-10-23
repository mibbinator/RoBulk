import type { StorageLike } from "./history";

// Features the user can switch off in the Options tab. Saved in the browser
// alongside everything else, so they apply on every page and every visit.

export interface Settings {
  /** Start loading sales as soon as RoBulk opens. */
  backgroundSales: boolean;
  /** Keep loaded sales in the browser so later visits only fetch new ones. */
  rememberSales: boolean;
  /** Look up Roblox's share for each price to show "you get R$…". */
  perSaleEarnings: boolean;
  /** Take a snapshot of prices and sale status once a day, for undo. */
  dailySnapshots: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  backgroundSales: true,
  rememberSales: true,
  perSaleEarnings: true,
  dailySnapshots: true,
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
