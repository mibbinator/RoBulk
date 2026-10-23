// Groups items into the categories shown in the panel.
// Asset type ids: https://create.roblox.com/docs/reference/engine/enums/AssetType

import type { SellableItem } from "../api/types";

export type CategoryId =
  | "shirts"
  | "pants"
  | "tshirts"
  | "layered"
  | "accessories"
  | "heads"
  | "other"
  | "gamePasses"
  | "devProducts";

export interface Category {
  id: CategoryId;
  label: string;
}

export const CATEGORIES: readonly Category[] = [
  { id: "shirts", label: "Classic Shirts" },
  { id: "pants", label: "Classic Pants" },
  { id: "tshirts", label: "Classic T-Shirts" },
  { id: "layered", label: "Layered Clothing" },
  { id: "accessories", label: "Accessories" },
  { id: "heads", label: "Heads & Faces" },
  { id: "other", label: "Other Avatar Items" },
  { id: "gamePasses", label: "Game Passes" },
  { id: "devProducts", label: "Developer Products" },
];

const ASSET_TYPE_TO_CATEGORY: Record<number, CategoryId> = {
  2: "tshirts",
  11: "shirts",
  12: "pants",
  // Rigid accessories: hat, hair, face, neck, shoulder, front, back, waist
  8: "accessories",
  41: "accessories",
  42: "accessories",
  43: "accessories",
  44: "accessories",
  45: "accessories",
  46: "accessories",
  47: "accessories",
  // Layered clothing: t-shirt, shirt, pants, jacket, sweater, shorts, shoes, dress/skirt
  64: "layered",
  65: "layered",
  66: "layered",
  67: "layered",
  68: "layered",
  69: "layered",
  70: "layered",
  71: "layered",
  72: "layered",
  // Faces, heads, eyebrows, eyelashes, dynamic heads
  17: "heads",
  18: "heads",
  76: "heads",
  77: "heads",
  79: "heads",
};

export function categoryForAssetType(assetType: number): CategoryId {
  return ASSET_TYPE_TO_CATEGORY[assetType] ?? "other";
}

export function categoryFor(item: SellableItem): CategoryId {
  if (item.kind === "gamePass") return "gamePasses";
  if (item.kind === "devProduct") return "devProducts";
  return categoryForAssetType(item.assetType ?? 0);
}
