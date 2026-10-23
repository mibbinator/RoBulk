import type { SellableItem } from "../api/types";
import type { Edit } from "./edits";

// Snapshots (for undo / restore) and the activity log, kept in
// chrome.storage.local so they survive closing the browser. Nothing leaves
// the user's machine.

export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Stored keys starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  /** Bytes used by these keys, or null if the browser can't tell. */
  bytesInUse(keys: string[]): Promise<number | null>;
}

export function chromeStorage(): StorageLike {
  const local = chrome.storage.local as chrome.storage.LocalStorageArea & { getKeys?: () => Promise<string[]> };
  return {
    async get(key) {
      const result = await local.get(key);
      return result[key];
    },
    async set(key, value) {
      await local.set({ [key]: value });
    },
    async remove(key) {
      await local.remove(key);
    },
    async keys(prefix) {
      // getKeys is newer (Chrome 130); older browsers have to read everything once.
      const all = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
      return all.filter((k) => k.startsWith(prefix));
    },
    async bytesInUse(keys) {
      try {
        return keys.length ? await local.getBytesInUse(keys) : 0;
      } catch {
        return null; // Firefox doesn't support it everywhere.
      }
    },
  };
}

export function memoryStorage(): StorageLike {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return structuredClone(data.get(key));
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async bytesInUse(keys) {
      return keys.reduce((sum, k) => sum + (data.has(k) ? JSON.stringify(data.get(k)).length : 0), 0);
    },
  };
}

export interface SnapshotItem {
  key: string;
  name: string;
  price: number | null;
  onSale: boolean;
  managedPricing?: boolean;
  description?: string;
}

export type SnapshotReason = "auto" | "manual" | "beforeSave";

export interface Snapshot {
  id: string;
  creatorKey: string;
  takenAt: string;
  reason: SnapshotReason;
  items: SnapshotItem[];
}

export interface LogEntry {
  at: string;
  creatorKey: string;
  itemKey: string;
  itemName: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  ok: boolean;
  error?: string;
}

const SNAPSHOTS_PER_CREATOR = 30;
const LOG_LIMIT = 3000;
const AUTO_SNAPSHOT_EVERY_MS = 20 * 60 * 60 * 1000;

const snapshotsKey = (creatorKey: string) => `snapshots:${creatorKey}`;

export function snapshotOf(items: SellableItem[], withDescriptions = false): SnapshotItem[] {
  return items.map((i) => ({
    key: i.key,
    name: i.name,
    price: i.price,
    onSale: i.onSale,
    ...(i.managedPricing !== undefined ? { managedPricing: i.managedPricing } : {}),
    ...(withDescriptions && i.description !== undefined ? { description: i.description } : {}),
  }));
}

export class History {
  constructor(private storage: StorageLike, private now: () => Date = () => new Date()) {}

  async snapshots(creatorKey: string): Promise<Snapshot[]> {
    return ((await this.storage.get(snapshotsKey(creatorKey))) as Snapshot[] | undefined) ?? [];
  }

  async addSnapshot(creatorKey: string, reason: SnapshotReason, items: SnapshotItem[]): Promise<Snapshot> {
    const snapshot: Snapshot = {
      id: `${this.now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      creatorKey,
      takenAt: this.now().toISOString(),
      reason,
      items,
    };
    const list = [snapshot, ...(await this.snapshots(creatorKey))].slice(0, SNAPSHOTS_PER_CREATOR);
    await this.storage.set(snapshotsKey(creatorKey), list);
    return snapshot;
  }

  async deleteSnapshot(creatorKey: string, id: string): Promise<void> {
    await this.storage.set(snapshotsKey(creatorKey), (await this.snapshots(creatorKey)).filter((s) => s.id !== id));
  }

  /** Takes a daily snapshot so a store can be restored even without planning ahead. */
  async autoSnapshot(creatorKey: string, items: SellableItem[]): Promise<Snapshot | null> {
    if (items.length === 0) return null;
    const lastAuto = (await this.snapshots(creatorKey)).find((s) => s.reason === "auto");
    if (lastAuto && this.now().getTime() - new Date(lastAuto.takenAt).getTime() < AUTO_SNAPSHOT_EVERY_MS) return null;
    return this.addSnapshot(creatorKey, "auto", snapshotOf(items));
  }

  async log(creatorKey?: string): Promise<LogEntry[]> {
    const all = ((await this.storage.get("log")) as LogEntry[] | undefined) ?? [];
    return creatorKey ? all.filter((e) => e.creatorKey === creatorKey) : all;
  }

  async appendLog(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const all = [...entries.slice().reverse(), ...(await this.log())].slice(0, LOG_LIMIT);
    await this.storage.set("log", all);
  }

  async clearLog(creatorKey: string): Promise<void> {
    await this.storage.set("log", (await this.log()).filter((e) => e.creatorKey !== creatorKey));
  }
}

/** Staged edits that put items back the way the snapshot recorded them. */
export function restorePatches(snapshot: Snapshot, items: SellableItem[]): { item: SellableItem; patch: Edit }[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const patches: { item: SellableItem; patch: Edit }[] = [];
  for (const saved of snapshot.items) {
    const item = byKey.get(saved.key);
    if (!item) continue;
    const patch: Edit = { name: saved.name, onSale: saved.onSale };
    if (saved.price != null) patch.price = saved.price;
    if (saved.managedPricing !== undefined) patch.managedPricing = saved.managedPricing;
    if (saved.description !== undefined) patch.description = saved.description;
    patches.push({ item, patch });
  }
  return patches;
}

/** Log changes as "from → to" pairs for the fields an edit touched. */
export function describeChanges(item: SellableItem, edit: Edit): LogEntry["changes"] {
  const changes: LogEntry["changes"] = {};
  const before: Record<string, unknown> = {
    price: item.price,
    onSale: item.onSale,
    managedPricing: item.managedPricing,
    regionalPricing: item.regionalPricing,
    name: item.name,
    description: item.description ?? "",
    schedule: null,
  };
  for (const [field, to] of Object.entries(edit)) changes[field] = { from: before[field] ?? null, to };
  return changes;
}
