import type { SaleTransaction } from "./earnings";
import type { StorageLike } from "./history";

// When the user last looked at a creator's Earnings report, so RoBulk can
// count the sales that came in since ("+12" on the sidebar entry, and a line
// at the top of the report).

const key = (creatorKey: string) => `seen:${creatorKey}`;
export const SEEN_CHANGED = "robulk:seen-changed";

export async function readSeen(storage: StorageLike, creatorKey: string): Promise<string | null> {
  return ((await storage.get(key(creatorKey))) as string | undefined) ?? null;
}

export async function markSeen(storage: StorageLike, creatorKey: string, now = new Date()): Promise<void> {
  await storage.set(key(creatorKey), now.toISOString());
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SEEN_CHANGED));
}

/** Sales newer than `since` (newest-first list, so it stops at the first older one). */
export function salesSince(sales: SaleTransaction[], since: string): { count: number; robux: number } {
  const from = new Date(since).getTime();
  let count = 0;
  let robux = 0;
  for (const s of sales) {
    if (new Date(s.created).getTime() <= from) break;
    count++;
    robux += s.robux;
  }
  return { count, robux };
}
