import type { Creator, CreatorType, SellableItem } from "../api/types";
import type { StorageLike } from "./history";

// The off-sale alarm. RoBulk remembers which avatar items each creator had on
// sale whenever it loads or saves them. When the user visits Roblox or the
// Creator Dashboard, the catalog is checked again (at most every few
// minutes), and items that went off sale without RoBulk doing it raise an
// alert. That's what happens when a group owner's Premium lapses, for example.
//
// An alert shows as a banner once on roblox.com and once on the dashboard,
// and each stays until it's closed on that site.

export type Site = "roblox" | "dashboard";

export interface WatchedItem {
  id: number;
  name: string;
  onSale: boolean;
}

interface Baseline {
  creatorType: CreatorType;
  creatorId: number;
  creatorName: string;
  /** When RoBulk last loaded or saved these items itself. */
  rememberedAt: string;
  /** Items on sale at the time: [id, name]. */
  onSale: [number, string][];
}

export interface OffSaleAlert {
  id: string;
  creatorKey: string;
  creatorType: CreatorType;
  creatorId: number;
  creatorName: string;
  items: { id: number; name: string }[];
  detectedAt: string;
  dismissed: Record<Site, boolean>;
}

const BASELINE_PREFIX = "watch:";
const ALERTS_KEY = "offSaleAlerts";
const CHECKED_KEY = "watchCheckedAt";
/** How often the catalog is checked at most, across both sites. */
export const CHECK_EVERY_MS = 10 * 60_000;
/**
 * Items RoBulk itself changed take a while to show up in the catalog, so a
 * creator seen this recently isn't checked yet; otherwise putting something
 * on sale could look like it went off sale.
 */
export const SETTLE_MS = 15 * 60_000;

const keyOf = (type: CreatorType, id: number) => `${type}:${id}`;

/** Records what's on sale now, after RoBulk loads or saves a creator's avatar items. */
export async function rememberOnSale(storage: StorageLike, creator: Creator, items: SellableItem[], now = new Date()): Promise<void> {
  const avatar = items.filter((i) => i.kind === "avatar");
  if (avatar.length === 0) return;
  const baseline: Baseline = {
    creatorType: creator.type,
    creatorId: creator.id,
    creatorName: creator.name,
    rememberedAt: now.toISOString(),
    onSale: avatar.filter((i) => i.onSale).map((i) => [i.id, i.name]),
  };
  await storage.set(BASELINE_PREFIX + keyOf(creator.type, creator.id), baseline);
}

export async function readAlerts(storage: StorageLike): Promise<OffSaleAlert[]> {
  return ((await storage.get(ALERTS_KEY)) as OffSaleAlert[] | undefined) ?? [];
}

/** Alerts not closed on this site yet. */
export async function activeAlerts(storage: StorageLike, site: Site): Promise<OffSaleAlert[]> {
  return (await readAlerts(storage)).filter((a) => !a.dismissed[site]);
}

/** Closes an alert on one site; once it's closed on both, it's forgotten. */
export async function dismissAlert(storage: StorageLike, id: string, site: Site): Promise<void> {
  const alerts = (await readAlerts(storage))
    .map((a) => (a.id === id ? { ...a, dismissed: { ...a.dismissed, [site]: true } } : a))
    .filter((a) => !(a.dismissed.roblox && a.dismissed.dashboard));
  await storage.set(ALERTS_KEY, alerts);
}

/**
 * Checks every creator RoBulk has seen against the catalog and raises alerts
 * for items that went off sale. `list` returns a creator's avatar items as
 * the catalog shows them now. Returns the alerts that are new or grew.
 */
export async function checkOffSale(
  storage: StorageLike,
  list: (type: CreatorType, id: number) => Promise<WatchedItem[]>,
  { now = new Date(), force = false }: { now?: Date; force?: boolean } = {},
): Promise<OffSaleAlert[]> {
  const last = (await storage.get(CHECKED_KEY)) as string | undefined;
  if (!force && last && now.getTime() - new Date(last).getTime() < CHECK_EVERY_MS) return [];
  await storage.set(CHECKED_KEY, now.toISOString());

  const raised: OffSaleAlert[] = [];
  let alerts = await readAlerts(storage);
  for (const key of await storage.keys(BASELINE_PREFIX)) {
    const baseline = (await storage.get(key)) as Baseline | undefined;
    if (!baseline || now.getTime() - new Date(baseline.rememberedAt).getTime() < SETTLE_MS) continue;
    let current: WatchedItem[];
    try {
      current = await list(baseline.creatorType, baseline.creatorId);
    } catch {
      continue; // try again next time
    }
    // Only items still listed and now off sale; one that disappeared may have been deleted or moderated.
    const byId = new Map(current.map((i) => [i.id, i]));
    const wentOff = baseline.onSale.filter(([id]) => byId.get(id)?.onSale === false).map(([id, name]) => ({ id, name: byId.get(id)?.name ?? name }));

    await storage.set(key, {
      ...baseline,
      onSale: current.filter((i) => i.onSale).map((i) => [i.id, i.name]),
    } satisfies Baseline);
    if (wentOff.length === 0) continue;

    const creatorKey = keyOf(baseline.creatorType, baseline.creatorId);
    // Add to an alert for the same creator that's still showing, rather than stacking banners.
    const open = alerts.find((a) => a.creatorKey === creatorKey && !a.dismissed.roblox && !a.dismissed.dashboard);
    if (open) {
      const known = new Set(open.items.map((i) => i.id));
      const merged = { ...open, items: [...open.items, ...wentOff.filter((i) => !known.has(i.id))] };
      alerts = alerts.map((a) => (a === open ? merged : a));
      raised.push(merged);
    } else {
      const alert: OffSaleAlert = {
        id: `${now.getTime()}-${baseline.creatorId}`,
        creatorKey,
        creatorType: baseline.creatorType,
        creatorId: baseline.creatorId,
        creatorName: baseline.creatorName,
        items: wentOff,
        detectedAt: now.toISOString(),
        dismissed: { roblox: false, dashboard: false },
      };
      alerts = [...alerts, alert];
      raised.push(alert);
    }
  }
  await storage.set(ALERTS_KEY, alerts);
  return raised;
}
