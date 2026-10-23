// Which group the Creator Dashboard itself has selected, so RoBulk can open on
// the same one. The dashboard keeps the selection in localStorage under
// `creatorHubGroup.<userId>` (a group id, or null for the user's own
// creations); creations pages also put it in the URL as ?groupId=.

type StorageReader = Pick<Storage, "getItem">;

function pageStorage(): StorageReader | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function dashboardGroupId(userId: number, search: string = location.search, storage: StorageReader | null = pageStorage()): number | null {
  const fromUrl = Number(new URLSearchParams(search).get("groupId"));
  if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
  try {
    const raw = storage?.getItem(`creatorHubGroup.${userId}`);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    const id = Number(typeof value === "object" && value !== null ? (value as { id?: unknown }).id : value);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
