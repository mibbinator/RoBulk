import type { SellableItem } from "../api/types";
import { CATEGORIES, categoryFor, categoryForAssetType, type CategoryId } from "./categories";

// Turns raw sale transactions into the numbers the earnings report draws.

export interface SaleTransaction {
  id: string;
  /** ISO timestamp. */
  created: string;
  isPending: boolean;
  /** Robux credited to the creator for this sale (already after Roblox's cut). */
  robux: number;
  buyer: { id: number; name: string };
  item: { id: number; name: string; type: string };
}

export interface DayPoint {
  /** Local date, YYYY-MM-DD. */
  date: string;
  robux: number;
  sales: number;
}

export interface Ranked {
  key: string;
  label: string;
  robux: number;
  sales: number;
}

export interface EarningsSummary {
  totalRobux: number;
  pendingRobux: number;
  sales: number;
  averagePerSale: number;
  uniqueBuyers: number;
  daily: DayPoint[];
  byCategory: (Ranked & { category: CategoryId | "otherFold" })[];
  topItems: Ranked[];
  topBuyers: Ranked[];
  perItem: Map<string, { robux: number; sales: number; daily: DayPoint[] }>;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Every local day from `from` to `to`, inclusive. */
export function dayRange(from: Date, to: Date): string[] {
  const days: string[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= end) {
    days.push(localDay(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/** Item key for a transaction, matching SellableItem.key. */
export function transactionItemKey(t: SaleTransaction): string {
  switch (t.item.type) {
    case "GamePass":
      return `gamePass:${t.item.id}`;
    case "DeveloperProduct":
      return `devProduct:${t.item.id}`;
    default:
      return `avatar:${t.item.id}`;
  }
}

function categoryOfTransaction(t: SaleTransaction, items: Map<string, SellableItem>): CategoryId {
  const known = items.get(transactionItemKey(t));
  if (known) return categoryFor(known);
  if (t.item.type === "GamePass") return "gamePasses";
  if (t.item.type === "DeveloperProduct") return "devProducts";
  return categoryForAssetType(0);
}

const MAX_SLICES = 6;

function rank(map: Map<string, Ranked>, limit: number): Ranked[] {
  return [...map.values()].sort((a, b) => b.robux - a.robux || b.sales - a.sales).slice(0, limit);
}

function bump(map: Map<string, Ranked>, key: string, label: string, robux: number) {
  const entry = map.get(key) ?? { key, label, robux: 0, sales: 0 };
  entry.robux += robux;
  entry.sales += 1;
  map.set(key, entry);
}

export function summarize(transactions: SaleTransaction[], from: Date, to: Date, items: SellableItem[] = []): EarningsSummary {
  const days = dayRange(from, to);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const daily: DayPoint[] = days.map((date) => ({ date, robux: 0, sales: 0 }));
  const itemMap = new Map(items.map((i) => [i.key, i]));

  const categories = new Map<string, Ranked>();
  const topItems = new Map<string, Ranked>();
  const buyers = new Map<string, Ranked>();
  const perItem = new Map<string, { robux: number; sales: number; daily: DayPoint[] }>();
  let totalRobux = 0;
  let pendingRobux = 0;
  let sales = 0;

  for (const t of transactions) {
    const created = new Date(t.created);
    const i = dayIndex.get(localDay(created));
    if (i === undefined) continue;
    sales++;
    totalRobux += t.robux;
    if (t.isPending) pendingRobux += t.robux;
    daily[i].robux += t.robux;
    daily[i].sales += 1;

    const category = categoryOfTransaction(t, itemMap);
    bump(categories, category, CATEGORIES.find((c) => c.id === category)?.label ?? "Other", t.robux);
    const key = transactionItemKey(t);
    bump(topItems, key, itemMap.get(key)?.name ?? t.item.name, t.robux);
    bump(buyers, String(t.buyer.id), t.buyer.name, t.robux);

    const stats = perItem.get(key) ?? { robux: 0, sales: 0, daily: days.map((date) => ({ date, robux: 0, sales: 0 })) };
    stats.robux += t.robux;
    stats.sales += 1;
    stats.daily[i].robux += t.robux;
    stats.daily[i].sales += 1;
    perItem.set(key, stats);
  }

  // Keep category order stable (so colors follow categories), fold the tail.
  const orderedCategories = CATEGORIES.map((c) => categories.get(c.id))
    .filter((c): c is Ranked => !!c)
    .map((c) => ({ ...c, category: c.key as CategoryId }));
  const byRevenue = [...orderedCategories].sort((a, b) => b.robux - a.robux);
  const kept = new Set(byRevenue.slice(0, MAX_SLICES - (byRevenue.length > MAX_SLICES ? 1 : 0)).map((c) => c.key));
  const byCategory: EarningsSummary["byCategory"] = orderedCategories.filter((c) => kept.has(c.key));
  const folded = orderedCategories.filter((c) => !kept.has(c.key));
  if (folded.length) {
    byCategory.push({
      key: "otherFold",
      label: "Everything else",
      category: "otherFold",
      robux: folded.reduce((s, c) => s + c.robux, 0),
      sales: folded.reduce((s, c) => s + c.sales, 0),
    });
  }

  return {
    totalRobux,
    pendingRobux,
    sales,
    averagePerSale: sales ? totalRobux / sales : 0,
    uniqueBuyers: buyers.size,
    daily,
    byCategory,
    topItems: rank(topItems, 10),
    topBuyers: rank(buyers, 10),
    perItem,
  };
}

/** Change between two totals as a fraction, or null when there's no baseline. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}
