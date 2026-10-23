import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { memoryStorage } from "../core/history";
import { SalesCache } from "../core/salesCache";
import { forgetSalesLoaders, salesLoader } from "./salesLoader";

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
  const waiting: (() => void)[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/currency")) return json({ robux: 50 });
    const cursor = new URL(url).searchParams.get("cursor") ?? "";
    requested.push(cursor);
    await new Promise<void>((r) => waiting.push(r));
    return json(PAGES[cursor]);
  });
  /** Lets the next waiting page through and waits for it to be handled. */
  const release = async () => {
    for (let i = 0; i < 100 && waiting.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    waiting.shift()?.();
    await new Promise((r) => setTimeout(r, 20));
  };
  return { fetchImpl, requested, release };
}

function setup() {
  const roblox = fakeRoblox();
  const cache = new SalesCache(memoryStorage());
  const loader = salesLoader(me, createClient(roblox.fetchImpl), cache, () => true);
  return { ...roblox, cache, loader };
}

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
    expect(saved!.olderCursor).toBe("p2");
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
});
