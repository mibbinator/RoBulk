export type CreatorType = "User" | "Group";

export interface Creator {
  type: CreatorType;
  id: number;
  name: string;
}

/** An avatar item (clothing, accessory, ...) as RoBulk tracks it. */
export interface AvatarItem {
  assetId: number;
  assetType: number;
  name: string;
  /** Internal id Roblox uses for sale settings; differs from assetId. */
  collectibleItemId: string | null;
  price: number | null;
  onSale: boolean;
}
