// RoBulk's overflow store for saved sales, in the extension's own IndexedDB.
//
// Sales are normally saved in the extension's storage. Only when a save there
// fails does RoBulk put them here instead. This script does nothing on its own:
// the browser starts it when RoBulk sends it a message and stops it again
// once it's idle.

const DB_NAME = "robulk";
const STORE = "sales";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    let result;
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function handle(message) {
  switch (message.robulkSales) {
    case "get":
      return withStore("readonly", (s) => s.get(message.key));
    case "set":
      return withStore("readwrite", (s) => s.put(message.value, message.key));
    case "remove":
      return withStore("readwrite", (s) => s.delete(message.key));
    case "clear":
      return withStore("readwrite", (s) => s.clear());
    case "bytes": {
      const all = (await withStore("readonly", (s) => s.getAll())) ?? [];
      return all.reduce((sum, value) => sum + JSON.stringify(value).length, 0);
    }
    default:
      throw new Error(`Unknown request: ${message.robulkSales}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!message || typeof message.robulkSales !== "string") return false;
  handle(message).then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: String(error) }),
  );
  return true; // replying asynchronously
});
