import { describe, expect, it } from "vitest";
import type { Creator, SellableItem } from "../api/types";
import { memoryStorage } from "./history";
import { CHECK_EVERY_MS, SETTLE_MS, activeAlerts, checkOffSale, dismissAlert, rememberOnSale, type WatchedItem } from "./offSaleWatch";

const group: Creator = { type: "Group", id: 9, name: "Valor", access: { avatarItems: true, experiences: true, earnings: true } };
const item = (id: number, onSale: boolean): SellableItem => ({ key: `avatar:${id}`, kind: "avatar", id, name: `Shirt ${id}`, price: 5, onSale });
const t0 = new Date("2026-10-23T12:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("off-sale alarm", () => {
  it("raises an alert for items that went off sale without RoBulk", async () => {
    const storage = memoryStorage();
    await rememberOnSale(storage, group, [item(1, true), item(2, true), item(3, false)], t0);

    const catalog: WatchedItem[] = [
      { id: 1, name: "Shirt 1", onSale: false },
      { id: 2, name: "Shirt 2", onSale: true },
      { id: 3, name: "Shirt 3", onSale: false },
    ];
    const raised = await checkOffSale(storage, async () => catalog, { now: later(SETTLE_MS + 1) });

    expect(raised).toHaveLength(1);
    expect(raised[0].creatorName).toBe("Valor");
    expect(raised[0].items).toEqual([{ id: 1, name: "Shirt 1" }]); // 3 was already off sale
    expect(await activeAlerts(storage, "roblox")).toHaveLength(1);
    expect(await activeAlerts(storage, "dashboard")).toHaveLength(1);
  });

  it("stays on each site until it's closed there", async () => {
    const storage = memoryStorage();
    await rememberOnSale(storage, group, [item(1, true)], t0);
    const [alert] = await checkOffSale(storage, async () => [{ id: 1, name: "Shirt 1", onSale: false }], { now: later(SETTLE_MS + 1) });

    await dismissAlert(storage, alert.id, "roblox");
    expect(await activeAlerts(storage, "roblox")).toHaveLength(0);
    expect(await activeAlerts(storage, "dashboard")).toHaveLength(1);

    await dismissAlert(storage, alert.id, "dashboard");
    expect(await activeAlerts(storage, "dashboard")).toHaveLength(0);
  });

  it("doesn't alert twice for the same items, and adds new ones to the open alert", async () => {
    const storage = memoryStorage();
    await rememberOnSale(storage, group, [item(1, true), item(2, true)], t0);
    await checkOffSale(storage, async () => [{ id: 1, name: "Shirt 1", onSale: false }, { id: 2, name: "Shirt 2", onSale: true }], { now: later(SETTLE_MS + 1) });
    // Still off on the next check: nothing new.
    expect(await checkOffSale(storage, async () => [{ id: 1, name: "Shirt 1", onSale: false }, { id: 2, name: "Shirt 2", onSale: true }], { now: later(SETTLE_MS * 3) })).toEqual([]);
    // Another one goes off: same banner, one more item.
    await checkOffSale(storage, async () => [{ id: 1, name: "Shirt 1", onSale: false }, { id: 2, name: "Shirt 2", onSale: false }], { now: later(SETTLE_MS * 5) });
    const [alert] = await activeAlerts(storage, "dashboard");
    expect(alert.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it("waits for RoBulk's own changes to reach the catalog", async () => {
    const storage = memoryStorage();
    const list = async () => [{ id: 1, name: "Shirt 1", onSale: false }];
    await rememberOnSale(storage, group, [item(1, true)], t0);
    // Just put on sale through RoBulk; the catalog may not show it yet.
    expect(await checkOffSale(storage, list, { now: later(60_000) })).toEqual([]);
    expect(await checkOffSale(storage, list, { now: later(SETTLE_MS + 1) })).toHaveLength(1);
  });

  it("checks the catalog at most every few minutes", async () => {
    const storage = memoryStorage();
    let onSale = true;
    const list = async () => [{ id: 1, name: "Shirt 1", onSale }];
    await rememberOnSale(storage, group, [item(1, true)], t0);
    const first = later(SETTLE_MS + 1);
    expect(await checkOffSale(storage, list, { now: first })).toEqual([]);
    onSale = false;
    expect(await checkOffSale(storage, list, { now: new Date(first.getTime() + 60_000) })).toEqual([]);
    expect(await checkOffSale(storage, list, { now: new Date(first.getTime() + CHECK_EVERY_MS) })).toHaveLength(1);
  });

  it("ignores items that disappeared and creators the catalog couldn't load", async () => {
    const storage = memoryStorage();
    await rememberOnSale(storage, group, [item(1, true)], t0);
    expect(await checkOffSale(storage, async () => [], { now: later(SETTLE_MS + 1) })).toEqual([]);
    expect(
      await checkOffSale(storage, async () => Promise.reject(new Error("offline")), { now: later(SETTLE_MS * 3), force: true }),
    ).toEqual([]);
  });
});
