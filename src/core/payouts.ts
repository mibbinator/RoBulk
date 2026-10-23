import { transactionItemKey, type SaleTransaction } from "./earnings";
import type { StorageLike } from "./history";

// Designer payouts for a group: each designer gets a share of what their
// items earned the group. RoBulk only works out the amounts. Paying them is
// done on Roblox's own payouts page, so RoBulk never moves Robux itself.

export interface Designer {
  userId: number;
  name: string;
  /** Percent of what their items earned. */
  share: number;
  /** SellableItem keys of the items they're paid for. */
  itemKeys: string[];
  /** Paid up to this moment; the next period starts here. */
  paidThrough: string | null;
}

export interface PaidRecord {
  userId: number;
  name: string;
  amount: number;
  from: string;
  to: string;
  markedAt: string;
}

export interface PayoutPlan {
  designers: Designer[];
  paid: PaidRecord[];
}

const key = (groupKey: string) => `payouts:${groupKey}`;

export async function readPlan(storage: StorageLike, groupKey: string): Promise<PayoutPlan> {
  const saved = (await storage.get(key(groupKey))) as PayoutPlan | undefined;
  return { designers: saved?.designers ?? [], paid: saved?.paid ?? [] };
}

export async function writePlan(storage: StorageLike, groupKey: string, plan: PayoutPlan): Promise<void> {
  await storage.set(key(groupKey), plan);
}

export interface Owed {
  sales: number;
  /** What the designer's items earned the group in the period. */
  earned: number;
  /** The designer's cut, rounded down to whole Robux. */
  amount: number;
}

/** What a designer is owed for sales from `from` (exclusive) to `to` (inclusive). */
export function owed(designer: Designer, sales: SaleTransaction[], from: Date, to: Date): Owed {
  const items = new Set(designer.itemKeys);
  const start = from.getTime();
  const end = to.getTime();
  let count = 0;
  let earned = 0;
  for (const s of sales) {
    const at = new Date(s.created).getTime();
    if (at <= start || at > end || !items.has(transactionItemKey(s))) continue;
    count++;
    earned += s.robux;
  }
  return { sales: count, earned, amount: Math.floor((earned * designer.share) / 100) };
}

/** Records a payout and moves each paid designer's next period to start after it. */
export function markPaid(plan: PayoutPlan, payments: { designer: Designer; amount: number; from: Date }[], to: Date, now = new Date()): PayoutPlan {
  const paidIds = new Set(payments.map((p) => p.designer.userId));
  return {
    designers: plan.designers.map((d) => (paidIds.has(d.userId) ? { ...d, paidThrough: to.toISOString() } : d)),
    paid: [
      ...payments.map((p) => ({ userId: p.designer.userId, name: p.designer.name, amount: p.amount, from: p.from.toISOString(), to: to.toISOString(), markedAt: now.toISOString() })),
      ...plan.paid,
    ].slice(0, 500),
  };
}
