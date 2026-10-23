import type { DraftProduct } from "../core/templates";
import type { RobloxClient } from "./http";
import { itemKey, type Creator, type Experience, type ItemKind, type SellableItem } from "./types";

// Game passes and developer products use Roblox's documented APIs, which
// accept the normal browser session:
//   https://create.roblox.com/docs/cloud/reference/features/game-passes
//   https://create.roblox.com/docs/cloud/reference/features/developer-products
// Their PATCH endpoints take multipart form data and only change the fields
// that are sent.
const APIS = "https://apis.roblox.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

interface PriceInformation {
  defaultPriceInRobux?: number | null;
  enabledFeatures?: string[];
}

interface GamePassConfig {
  gamePassId: number;
  name: string;
  description?: string | null;
  isForSale: boolean;
  iconAssetId?: number | null;
  priceInformation?: PriceInformation | null;
  isManagedPricingEnabled?: boolean;
}

interface DeveloperProductConfig {
  productId: number;
  name: string;
  description?: string | null;
  isForSale: boolean;
  iconImageAssetId?: number | null;
  priceInformation?: PriceInformation | null;
  isManagedPricingEnabled?: boolean;
}

interface UniversesPage {
  data: { id: number; name: string }[];
  nextPageCursor: string | null;
}

/** Experiences owned by the creator, newest first. */
export async function listExperiences(client: RobloxClient, creator: Creator): Promise<Experience[]> {
  const base =
    creator.type === "Group"
      ? `https://develop.roblox.com/v1/groups/${creator.id}/universes`
      : "https://develop.roblox.com/v1/user/universes";
  const experiences: Experience[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ isArchived: "false", limit: "50", sortOrder: "Desc" });
    if (cursor) params.set("cursor", cursor);
    const res = await client.json<UniversesPage>(`${base}?${params}`);
    experiences.push(...res.data.map((u) => ({ universeId: u.id, name: u.name })));
    if (!res.nextPageCursor) break;
    cursor = res.nextPageCursor;
  }
  return experiences;
}

async function listPaged<T>(client: RobloxClient, url: string, key: string): Promise<T[]> {
  const all: T[] = [];
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (token) params.set("pageToken", token);
    const res = await client.json<Record<string, unknown>>(`${url}?${params}`);
    all.push(...((res[key] as T[] | undefined) ?? []));
    token = (res.nextPageToken as string | undefined) ?? "";
    if (!token) break;
  }
  return all;
}

const hasRegionalPricing = (p?: PriceInformation | null) =>
  p?.enabledFeatures ? p.enabledFeatures.some((f) => /regional/i.test(f)) : undefined;

export function toGamePassItem(universeId: number, p: GamePassConfig): SellableItem {
  return {
    key: itemKey("gamePass", p.gamePassId),
    kind: "gamePass",
    id: p.gamePassId,
    universeId,
    name: p.name,
    description: p.description ?? "",
    price: p.priceInformation?.defaultPriceInRobux ?? null,
    onSale: p.isForSale,
    managedPricing: p.isManagedPricingEnabled ?? false,
    regionalPricing: hasRegionalPricing(p.priceInformation),
  };
}

export function toDevProductItem(universeId: number, p: DeveloperProductConfig): SellableItem {
  return {
    key: itemKey("devProduct", p.productId),
    kind: "devProduct",
    id: p.productId,
    universeId,
    name: p.name,
    description: p.description ?? "",
    price: p.priceInformation?.defaultPriceInRobux ?? null,
    onSale: p.isForSale,
    managedPricing: p.isManagedPricingEnabled ?? false,
    regionalPricing: hasRegionalPricing(p.priceInformation),
  };
}

export async function listGamePasses(client: RobloxClient, universeId: number): Promise<SellableItem[]> {
  const passes = await listPaged<GamePassConfig>(
    client,
    `${APIS}/game-passes/v1/universes/${universeId}/game-passes/creator`,
    "gamePasses",
  );
  return passes.map((p) => toGamePassItem(universeId, p));
}

export async function listDevProducts(client: RobloxClient, universeId: number): Promise<SellableItem[]> {
  const products = await listPaged<DeveloperProductConfig>(
    client,
    `${APIS}/developer-products/v2/universes/${universeId}/developer-products/creator`,
    "developerProducts",
  );
  return products.map((p) => toDevProductItem(universeId, p));
}

export interface ExperienceItemChanges {
  name?: string;
  description?: string;
  price?: number;
  onSale?: boolean;
  managedPricing?: boolean;
  regionalPricing?: boolean;
}

/** Only the changed fields, so nothing else about the pass/product is touched. */
export function buildExperienceForm(changes: ExperienceItemChanges): FormData {
  const form = new FormData();
  if (changes.name !== undefined) form.append("name", changes.name);
  if (changes.description !== undefined) form.append("description", changes.description);
  if (changes.price !== undefined) form.append("price", String(changes.price));
  if (changes.onSale !== undefined) form.append("isForSale", String(changes.onSale));
  if (changes.managedPricing !== undefined) form.append("isManagedPricingEnabled", String(changes.managedPricing));
  if (changes.regionalPricing !== undefined) form.append("isRegionalPricingEnabled", String(changes.regionalPricing));
  return form;
}

const collectionUrl = (kind: Exclude<ItemKind, "avatar">, universeId: number) =>
  kind === "gamePass"
    ? `${APIS}/game-passes/v1/universes/${universeId}/game-passes`
    : `${APIS}/developer-products/v2/universes/${universeId}/developer-products`;

export async function saveExperienceItem(client: RobloxClient, item: SellableItem, changes: ExperienceItemChanges): Promise<void> {
  const kind = item.kind as Exclude<ItemKind, "avatar">;
  await client.request(`${collectionUrl(kind, item.universeId!)}/${item.id}`, {
    method: "PATCH",
    body: buildExperienceForm(changes),
  });
}

/** Creates a game pass or developer product. Returns its new id when Roblox reports it. */
export async function createExperienceItem(
  client: RobloxClient,
  kind: Exclude<ItemKind, "avatar">,
  universeId: number,
  draft: DraftProduct,
  image?: Blob,
): Promise<number | null> {
  const form = buildExperienceForm({ name: draft.name, description: draft.description, price: draft.price, onSale: draft.onSale });
  if (image) form.append("imageFile", image, "icon.png");
  const res = await client.request(collectionUrl(kind, universeId), { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as { gamePassId?: number; productId?: number };
  return body.gamePassId ?? body.productId ?? null;
}

/** Downloads an item's icon so it can be re-uploaded when copying. */
export async function fetchIcon(url: string): Promise<Blob | undefined> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : undefined;
  } catch {
    return undefined;
  }
}
