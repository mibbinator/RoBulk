import { saveAvatarItem, updateDisplayInfo } from "../api/avatarSale";
import { saveExperienceItem } from "../api/experiences";
import type { RobloxClient } from "../api/http";
import type { PendingChange } from "./edits";

/** Sends one pending change to Roblox using the right API(s) for its kind. */
export async function saveChange(client: RobloxClient, change: PendingChange): Promise<void> {
  const { item, changed, settings } = change;
  if (item.kind !== "avatar") {
    await saveExperienceItem(client, item, {
      name: changed.name,
      description: changed.description,
      price: changed.price,
      onSale: changed.onSale,
      managedPricing: changed.managedPricing,
      regionalPricing: changed.regionalPricing,
    });
    return;
  }

  const saleTouched =
    changed.price !== undefined || changed.onSale !== undefined || changed.regionalPricing !== undefined || changed.schedule !== undefined;
  if (saleTouched) {
    await saveAvatarItem(client, item.id, settings, { regionalPricing: changed.regionalPricing, schedule: changed.schedule });
  }
  if (changed.name !== undefined || changed.description !== undefined) {
    await updateDisplayInfo(client, item.id, changed.name ?? item.name, changed.description ?? item.description ?? "");
  }
}
