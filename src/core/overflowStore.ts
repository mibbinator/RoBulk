// Talks to the background script's IndexedDB store (public/background.js),
// which keeps saved sales that the extension's storage couldn't take. The
// content script can't use the extension's IndexedDB directly: in a web page,
// IndexedDB belongs to the website, and sales shouldn't be stored where the
// page can read them.

export interface OverflowStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Roughly how much is stored, in bytes. */
  bytes(): Promise<number>;
}

function send(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message }, (reply?: { ok: boolean; value?: unknown; error?: string }) => {
      const failed = chrome.runtime.lastError;
      if (failed) reject(new Error(failed.message));
      else if (!reply?.ok) reject(new Error(reply?.error ?? "No answer from RoBulk's background store"));
      else resolve(reply.value);
    });
  });
}

/** The background store, or null outside the extension (preview page, tests). */
export function extensionOverflowStore(): OverflowStore | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage || !chrome.runtime.id) return null;
  return {
    get: (key) => send({ robulkSales: "get", key }),
    set: async (key, value) => void (await send({ robulkSales: "set", key, value })),
    remove: async (key) => void (await send({ robulkSales: "remove", key })),
    clear: async () => void (await send({ robulkSales: "clear" })),
    bytes: async () => Number(await send({ robulkSales: "bytes" })) || 0,
  };
}

/** An in-memory stand-in, for tests. */
export function memoryOverflowStore(): OverflowStore {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    remove: async (key) => void data.delete(key),
    clear: async () => data.clear(),
    bytes: async () => [...data.values()].reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0),
  };
}
