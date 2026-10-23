import type { SellableItem } from "../api/types";

// Unsaved edits, keyed by item key. An edit only holds fields that differ from
// the item as last loaded, so "changed back" edits disappear on their own.

export interface SaleSchedule {
  /** ISO timestamps; null means "no start" / "no end". */
  start: string | null;
  end: string | null;
}

export interface Edit {
  price?: number;
  onSale?: boolean;
  managedPricing?: boolean;
  regionalPricing?: boolean;
  name?: string;
  description?: string;
  /** Avatar items only. */
  schedule?: SaleSchedule;
}

export type Edits = ReadonlyMap<string, Edit>;

export type BulkAction =
  | { kind: "setPrice"; price: number }
  | { kind: "putOnSale" }
  | { kind: "takeOffSale" }
  | { kind: "setManagedPricing"; enabled: boolean }
  | { kind: "setRegionalPricing"; enabled: boolean }
  | { kind: "schedule"; schedule: SaleSchedule };

export function effective(item: SellableItem, edit: Edit | undefined) {
  return {
    price: edit?.price ?? item.price,
    onSale: edit?.onSale ?? item.onSale,
    managedPricing: edit?.managedPricing ?? item.managedPricing,
    regionalPricing: edit?.regionalPricing ?? item.regionalPricing,
    name: edit?.name ?? item.name,
    description: edit?.description ?? item.description ?? "",
  };
}

function normalize(item: SellableItem, edit: Edit): Edit | null {
  const out: Edit = {};
  if (edit.price !== undefined && edit.price !== item.price) out.price = edit.price;
  if (edit.onSale !== undefined && edit.onSale !== item.onSale) out.onSale = edit.onSale;
  if (edit.managedPricing !== undefined && item.managedPricing !== undefined && edit.managedPricing !== item.managedPricing) {
    out.managedPricing = edit.managedPricing;
  }
  // Avatar items don't report regional pricing until saved, so keep the edit.
  if (edit.regionalPricing !== undefined && edit.regionalPricing !== item.regionalPricing) {
    out.regionalPricing = edit.regionalPricing;
  }
  if (edit.name !== undefined && edit.name !== item.name) out.name = edit.name;
  if (edit.description !== undefined && edit.description !== (item.description ?? "")) out.description = edit.description;
  if (edit.schedule && item.kind === "avatar") out.schedule = edit.schedule;
  return Object.keys(out).length === 0 ? null : out;
}

export function setEdit(edits: Edits, item: SellableItem, patch: Edit): Map<string, Edit> {
  const next = new Map(edits);
  const merged = normalize(item, { ...edits.get(item.key), ...patch });
  if (merged) next.set(item.key, merged);
  else next.delete(item.key);
  return next;
}

/** Applies a per-item patch (e.g. computed by a price rule) to many items. */
export function setEdits(edits: Edits, patches: { item: SellableItem; patch: Edit }[]): Map<string, Edit> {
  let next = new Map(edits);
  for (const { item, patch } of patches) next = setEdit(next, item, patch);
  return next;
}

function patchFor(action: BulkAction): Edit {
  switch (action.kind) {
    case "setPrice":
      return { price: action.price };
    case "putOnSale":
      return { onSale: true };
    case "takeOffSale":
      return { onSale: false };
    case "setManagedPricing":
      return { managedPricing: action.enabled };
    case "setRegionalPricing":
      return { regionalPricing: action.enabled };
    case "schedule":
      return { schedule: action.schedule, onSale: true };
  }
}

export function applyAction(edits: Edits, targets: SellableItem[], action: BulkAction): Map<string, Edit> {
  const patch = patchFor(action);
  // A schedule only applies to avatar items; don't flip passes on sale with it.
  const applicable = action.kind === "schedule" ? targets.filter((t) => t.kind === "avatar") : targets;
  return setEdits(edits, applicable.map((item) => ({ item, patch })));
}

export function isValidPrice(price: number): boolean {
  return Number.isInteger(price) && price >= 0;
}

export interface PendingChange {
  item: SellableItem;
  /** Only the fields being changed. */
  changed: Edit;
  /** Full price + sale status after the change (avatar items save both). */
  settings: { onSale: boolean; price: number };
  /** Why this change can't be saved, if it can't. */
  problem?: string;
}

const SALE_FIELDS = ["price", "onSale", "regionalPricing", "schedule"] as const;

export function pendingChanges(items: SellableItem[], edits: Edits): PendingChange[] {
  const changes: PendingChange[] = [];
  for (const item of items) {
    const edit = edits.get(item.key);
    if (!edit) continue;
    const { price, onSale, name } = effective(item, edit);
    const touchesSale = SALE_FIELDS.some((f) => edit[f] !== undefined);
    // Avatar sale saves always send a price; passes/products only need one to go on sale.
    const needsPrice =
      (item.kind === "avatar" && touchesSale) || edit.price !== undefined || (edit.onSale === true && price == null);
    let problem: string | undefined;
    if (needsPrice && price == null) problem = "Set a price first";
    else if (price != null && edit.price !== undefined && !isValidPrice(price)) problem = "Price must be a whole number of Robux";
    else if (edit.name !== undefined && name.trim() === "") problem = "Name can't be empty";
    else if (edit.schedule?.start && edit.schedule.end && edit.schedule.end <= edit.schedule.start) {
      problem = "Sale end must be after the start";
    }
    changes.push({ item, changed: edit, settings: { onSale, price: price ?? 0 }, problem });
  }
  return changes;
}
