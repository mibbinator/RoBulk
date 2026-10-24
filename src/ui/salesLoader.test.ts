import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { memoryStorage } from "../core/history";
import { SalesCache } from "../core/salesCache";
import { forgetSalesLoaders, loaderTiming, salesLoader } from "./salesLoader";

const me: Creator = { type: "User", id: 1, name: "me", access: { avatarItems: true, experiences: true, earnings: true } };
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const sale = (id: string, days: number) => ({
  idHash: id,
  created: daysAgo(days),
  isPending: false,
  agent: { id: 9, type: "User", name: "buyer" },
  details: { id: 5, name: "Shirt", type: "Asset" },
  currency: { amount: 3, type: "Robux" },
});

// Three pages of history, newest first. Each page waits until the test lets it through.
const PAGES: Record<string, { data: ReturnType<typeof sale>[]; nextPageCursor: string | null }> = {
  "": { data: [sale("a", 1), sale("b", 20)], nextPageCursor: "p2" },
  p2: { data: [sale("c", 100), sale("d", 200)], nextPageCursor: "p3" },
  p3: { data: [sale("e", 400)], nextPageCursor: null },
};

function fakeRoblox() {
  const requested: string[] = [];
  /** Cursors whose next request fails with this status. */
  const failOnce = new Map<string, number>();
  const waiting: (() => void)[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/currency")) return json({ robux: 50 });
    // These pages are in the economy service's format; the records service is refused, so loading falls back to it.
    if (url.includes("transaction-records-api")) return new Response(JSON.stringify({ errors: [{ message: "Not found" }] }), { status: 404 });
    const cursor = new URL(url).searchParams.get("cursor") ?? "";
    requested.push((url.includes("/groups/") ? "group " : "") + cursor);
    await new Promise<void>((r) => waiting.push(r));
    const status = failOnce.get(cursor);
    if (status) {
      failOnce.delete(cursor);
      return new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status });
    }
    return json(PAGES[cursor]);
  });
  /** Lets the next waiting page through and waits for it to be handled. */
  const release = async () => {
    for (let i = 0; i < 100 && waiting.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    waiting.shift()?.();
    await new Promise((r) => setTimeout(r, 20));
  };
  return { fetchImpl, requested, release, failOnce };
}

function setup() {
  const roblox = fakeRoblox();
  const cache = new SalesCache(memoryStorage());
  const loader = salesLoader(me, createClient(roblox.fetchImpl), cache, () => true);
  return { ...roblox, cache, loader };
}

loaderTiming.retryMs = 10;
afterEach(() => forgetSalesLoaders());

describe("SalesLoader", () => {
  it("saves every page to the browser as soon as it arrives", async () => {
    const { loader, cache, release } = setup();
    loader.load(null);

    await release();
    await loader.flushed();
    // Only the first page is in, and it's already saved, with where to carry on from.
    const saved = await cache.read("User:1");
    expect(saved!.sales.map((s) => s.id)).toEqual(["a", "b"]);
    expect(saved!.olderCursor).toBe("eco:p2");
    expect(loader.state.loading).toBe(true);

    await release();
    await loader.flushed();
    expect((await cache.read("User:1"))!.sales.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);

    await release();
    await loader.flushed();
    const done = await cache.read("User:1");
    expect(done!.coveredFrom).toBeNull(); // the whole history
    expect(loader.state.loading).toBe(false);
  });

  it("doesn't start over when the same range is asked for again while loading", async () => {
    const { loader, requested, release } = setup();
    loader.load(null);
    await release();
    loader.load(null); // clicking All time again
    loader.load(new Date(Date.now() - 60 * DAY)); // or a shorter range the load will cover anyway
    await release();
    await release();
    expect(requested).toEqual(["", "p2", "p3"]);
    expect(loader.state.entry!.sales).toHaveLength(5);
  });

  it("carries on from where a shorter load got to when a longer range is picked", async () => {
    const { loader, requested, release } = setup();
    loader.load(new Date(Date.now() - 60 * DAY));
    await release(); // page 1: a and b, not past 60 days yet
    await release(); // page 2 crosses 60 days, so that load is done
    expect(loader.state.loading).toBe(false);

    loader.load(null);
    await release();
    await release();
    // All time starts at page 2 (where 60 days ended), not back at the newest sale.
    expect(requested).toEqual(["", "p2", "p2", "p3"]);
    expect(loader.state.entry!.sales.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(loader.state.entry!.coveredFrom).toBeNull();
  });

  it("keeps what's loaded when stopped, and Keep loading picks up from there", async () => {
    const { loader, requested, release } = setup();
    loader.load(null);
    await release();
    loader.stop();
    expect(loader.state.loading).toBe(false);
    expect(loader.state.entry!.sales.map((s) => s.id)).toEqual(["a", "b"]);

    loader.load(null, { force: true });
    await release(); // the page that was on its way when Stop was clicked, now ignored
    await release();
    await release();
    // Only the page that was cut off is asked for again; page 1 isn't.
    expect(requested).toEqual(["", "p2", "p2", "p3"]);
    expect(loader.state.entry!.sales).toHaveLength(5);
  });

  it("is shared by everything on the page, so reopening RoBulk sees a load already under way", async () => {
    const { loader, cache, fetchImpl, release } = setup();
    loader.load(null);
    await release();
    // Reopening the panel asks for the same creator's loader again.
    const again = salesLoader(me, createClient(fetchImpl), cache, () => true);
    expect(again).toBe(loader);
    expect(again.state.loading).toBe(true);
    expect(again.state.entry!.sales).toHaveLength(2);
    await release();
    await release();
  });
  it("lets the selected group's load finish before a background load asks Roblox for anything", async () => {
    const { fetchImpl, requested, release, cache } = setup();
    const main = salesLoader(me, createClient(fetchImpl), cache, () => true);
    const group: Creator = { type: "Group", id: 9, name: "Other group", access: me.access };
    const other = salesLoader(group, createClient(fetchImpl), cache, () => true);

    main.load(null);
    other.load(null, { background: true });
    await release();
    expect(other.state.progress).toMatch(/Waiting for me to finish/);
    await release();
    await release();
    expect(main.state.loading).toBe(false);
    // Only now does the other group start.
    expect(requested).toEqual(["", "p2", "p3", "group "]);
    await release();
    await release();
    await release();
    expect(other.state.entry!.sales).toHaveLength(5);
  });
  it("never starts over: asking for more while loading widens the same load", async () => {
    const { loader, requested, release } = setup();
    loader.load(new Date(Date.now() - 60 * DAY));
    await release(); // page 1
    loader.load(null); // All time picked before 60 days finished
    await release();
    await release();
    expect(requested).toEqual(["", "p2", "p3"]);
    expect(loader.state.entry!.coveredFrom).toBeNull();
    expect(loader.state.loading).toBe(false);
  });

  it("holds a Refresh asked for mid-load until the load has finished", async () => {
    const { loader, requested, release } = setup();
    loader.load(null);
    await release();
    loader.load(null, { force: true });
    await release();
    await release();
    // The full history finished first; only then did the refresh ask for the newest sales.
    expect(requested).toEqual(["", "p2", "p3", ""]);
    await release();
    expect(loader.state.entry!.sales).toHaveLength(5);
  });

  it("tries a failed page again from where it got to, not from the newest sale", async () => {
    const { loader, requested, release, failOnce } = setup();
    failOnce.set("p2", 404);
    loader.load(null);
    await release(); // page 1 is kept
    await release(); // page 2 fails
    await release(); // page 2 again
    await release(); // page 3
    expect(requested).toEqual(["", "p2", "p2", "p3"]);
    expect(loader.state.entry!.sales).toHaveLength(5);
    expect(loader.state.error).toBeNull();
  });

  it("keeps one running count for the whole load", async () => {
    const { loader, release } = setup();
    loader.load(new Date(Date.now() - 60 * DAY));
    await release();
    await release(); // 60 days done: a and b
    expect(loader.state.loading).toBe(false);

    loader.load(null);
    await release(); // carries on from page 2: c and d
    // Counts on from the 2 already loaded, rather than starting again at 0.
    expect(loader.state.progress).toMatch(/^Loading older sales… 4 sales loaded/);
    await release();
    expect(loader.state.entry!.sales).toHaveLength(5);
  });
  it("catches back up when a new sale stops the economy service's cursor working, instead of starting over", async () => {
    const { loader, requested, release, failOnce } = setup();
    loader.load(new Date(Date.now() - 60 * DAY));
    await release(); // page 1: a and b
    await release(); // page 2 crosses 60 days; carrying on later starts there
    expect(loader.state.entry!.olderCursor).toBe("eco:p2");

    // A sale comes in, so Roblox no longer takes that cursor.
    failOnce.set("p2", 400);
    loader.load(null);
    await release(); // p2 refused
    await release(); // back from the newest page, skipping a and b
    await release(); // p2 again, now with c and d
    await release(); // p3: e
    expect(requested).toEqual(["", "p2", "p2", "", "p2", "p3"]);
    expect(loader.state.entry!.sales.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(loader.state.entry!.coveredFrom).toBeNull();
  });
});
