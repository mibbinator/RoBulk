import type { AvatarItem } from "../api/types";
import type { SaleSettings } from "../api/collectibles";

// Unsaved edits, keyed by assetId. An edit only holds fields that differ from
// the item as last loaded, so "changed back" edits disappear on their own.

export interface Edit {
  price?: number;
  onSale?: boolean;
}

export type Edits = ReadonlyMap<number, Edit>;

export type BulkAction =
  | { kind: "setPrice"; price: number }
  | { kind: "putOnSale" }
  | { kind: "takeOffSale" };

export function effective(item: AvatarItem, edit: Edit | undefined): { price: number | null; onSale: boolean } {
  return {
    price: edit?.price ?? item.price,
    onSale: edit?.onSale ?? item.onSale,
  };
}

function normalize(item: AvatarItem, edit: Edit): Edit | null {
  const out: Edit = {};
  if (edit.price !== undefined && edit.price !== item.price) out.price = edit.price;
  if (edit.onSale !== undefined && edit.onSale !== item.onSale) out.onSale = edit.onSale;
  return out.price === undefined && out.onSale === undefined ? null : out;
}

export function setEdit(edits: Edits, item: AvatarItem, patch: Edit): Map<number, Edit> {
  const next = new Map(edits);
  const merged = normalize(item, { ...edits.get(item.assetId), ...patch });
  if (merged) next.set(item.assetId, merged);
  else next.delete(item.assetId);
  return next;
}

export function applyAction(edits: Edits, targets: AvatarItem[], action: BulkAction): Map<number, Edit> {
  const patch: Edit =
    action.kind === "setPrice" ? { price: action.price } : { onSale: action.kind === "putOnSale" };
  let next = new Map(edits);
  for (const item of targets) next = setEdit(next, item, patch);
  return next;
}

export function isValidPrice(price: number): boolean {
  return Number.isInteger(price) && price >= 0;
}

export interface PendingChange {
  item: AvatarItem;
  settings: SaleSettings;
  /** Why this change can't be saved, if it can't. */
  problem?: string;
}

export function pendingChanges(items: AvatarItem[], edits: Edits): PendingChange[] {
  const changes: PendingChange[] = [];
  for (const item of items) {
    const edit = edits.get(item.assetId);
    if (!edit) continue;
    const { price, onSale } = effective(item, edit);
    const settings = { onSale, price: price ?? 0 };
    let problem: string | undefined;
    if (!item.collectibleItemId) problem = "Roblox didn't return a sale id for this item";
    else if (price == null) problem = "Set a price first";
    else if (!isValidPrice(price)) problem = "Price must be a whole number of Robux";
    changes.push({ item, settings, problem });
  }
  return changes;
}
