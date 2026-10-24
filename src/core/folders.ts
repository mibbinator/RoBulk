import type { StorageLike } from "./history";

// Folders the user sorts their items into (a Christmas set, a summer drop…),
// so a whole set can be put on or taken off sale together. Each creator has
// their own, saved in the browser. An item can be in more than one folder,
// and a folder keeps items that aren't listed right now (another experience,
// or not loaded yet) so nothing is lost.

export interface Folder {
  id: string;
  name: string;
  /** Item keys, as SellableItem.key. */
  itemKeys: string[];
}

interface StoredFolders {
  v: 1;
  folders: Folder[];
}

const keyFor = (creatorKey: string) => `folders:${creatorKey}`;

export async function readFolders(storage: StorageLike, creatorKey: string): Promise<Folder[]> {
  try {
    const saved = (await storage.get(keyFor(creatorKey))) as StoredFolders | undefined;
    return saved?.v === 1 && Array.isArray(saved.folders) ? saved.folders : [];
  } catch {
    return [];
  }
}

export async function writeFolders(storage: StorageLike, creatorKey: string, folders: Folder[]): Promise<void> {
  try {
    if (folders.length === 0) await storage.remove(keyFor(creatorKey));
    else await storage.set(keyFor(creatorKey), { v: 1, folders } satisfies StoredFolders);
  } catch {
    // The folders still work until the page is closed.
  }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createFolder(folders: Folder[], name: string, itemKeys: string[] = []): { folders: Folder[]; folder: Folder } {
  const folder = { id: newId(), name: name.trim(), itemKeys: [...new Set(itemKeys)] };
  return { folders: [...folders, folder], folder };
}

export const renameFolder = (folders: Folder[], id: string, name: string): Folder[] => folders.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));

export const deleteFolder = (folders: Folder[], id: string): Folder[] => folders.filter((f) => f.id !== id);

export const addToFolder = (folders: Folder[], id: string, itemKeys: string[]): Folder[] =>
  folders.map((f) => (f.id === id ? { ...f, itemKeys: [...new Set([...f.itemKeys, ...itemKeys])] } : f));

export function removeFromFolder(folders: Folder[], id: string, itemKeys: string[]): Folder[] {
  const drop = new Set(itemKeys);
  return folders.map((f) => (f.id === id ? { ...f, itemKeys: f.itemKeys.filter((k) => !drop.has(k)) } : f));
}

/** The names of the folders each item is in. */
export function folderNamesByItem(folders: Folder[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of folders) for (const k of f.itemKeys) out.set(k, [...(out.get(k) ?? []), f.name]);
  return out;
}
