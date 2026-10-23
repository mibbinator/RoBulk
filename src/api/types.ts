export type CreatorType = "User" | "Group";

/** What the signed-in user may do for a creator (always everything for themselves). */
export interface CreatorAccess {
  /** Edit clothing and other avatar items. */
  avatarItems: boolean;
  /** Edit experiences' game passes, developer products and badges. */
  experiences: boolean;
  /** See sales and revenue. */
  earnings: boolean;
}

export interface Creator {
  type: CreatorType;
  id: number;
  name: string;
  access: CreatorAccess;
  /** The signed-in user owns it (always true for their own account). */
  owned?: boolean;
}

export interface Experience {
  universeId: number;
  name: string;
}

export type ItemKind = "avatar" | "gamePass" | "devProduct";

/** Anything RoBulk can price and put on or off sale. */
export interface SellableItem {
  /** Unique across kinds: `${kind}:${id}`. */
  key: string;
  kind: ItemKind;
  /** assetId, gamePassId or productId. */
  id: number;
  name: string;
  description?: string;
  price: number | null;
  onSale: boolean;
  /** Game passes and developer products only. */
  managedPricing?: boolean;
  /** Known for passes/products; avatar items only reveal it when saving. */
  regionalPricing?: boolean;
  /** Avatar items only: the asset type id. */
  assetType?: number;
  /** Avatar items only: internal id Roblox uses for sale settings. */
  collectibleItemId?: string | null;
  /** Game passes and developer products only. */
  universeId?: number;
}

export const itemKey = (kind: ItemKind, id: number) => `${kind}:${id}`;
