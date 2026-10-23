// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../core/history";
import { activeAlerts, checkOffSale, rememberOnSale, SETTLE_MS } from "../core/offSaleWatch";
import { OffSaleBanner } from "./OffSaleBanner";

const group = { type: "Group" as const, id: 9, name: "Valor Designs", access: { avatarItems: true, experiences: true, earnings: true } };

async function withAlert() {
  const storage = memoryStorage();
  const t0 = new Date(Date.now() - SETTLE_MS * 2);
  await rememberOnSale(storage, group, [{ key: "avatar:1", kind: "avatar", id: 1, name: "Black Suit", price: 5, onSale: true }], t0);
  await checkOffSale(storage, async () => [{ id: 1, name: "Black Suit", onSale: false }], { now: new Date() });
  return storage;
}

const waitFor = async <T,>(fn: () => T | null | undefined | false): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("OffSaleBanner", () => {
  it("shows the alert until its ✕ is clicked, and only closes it on this site", async () => {
    const storage = await withAlert();
    const onReview = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    render(<OffSaleBanner site="dashboard" storage={storage} onReview={onReview} />, root);

    const banner = await waitFor(() => root.querySelector<HTMLElement>(".rb-alert"));
    expect(banner.textContent).toContain("1 item from Valor Designs went off sale");

    [...banner.querySelectorAll("button")].find((b) => b.textContent?.includes("Put back on sale"))!.click();
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ creatorKey: "Group:9", items: [{ id: 1, name: "Black Suit" }] }));

    banner.querySelector<HTMLButtonElement>(".rb-alert-close")!.click();
    await waitFor(() => !root.querySelector(".rb-alert"));
    expect(await activeAlerts(storage, "dashboard")).toHaveLength(0);
    expect(await activeAlerts(storage, "roblox")).toHaveLength(1); // still shows once on roblox.com
  });

  it("links to the fix in RoBulk from roblox.com", async () => {
    const storage = await withAlert();
    const root = document.createElement("div");
    document.body.append(root);
    render(<OffSaleBanner site="roblox" storage={storage} reviewHref={(a) => `https://create.roblox.com/dashboard/creations?robulkAlert=${a.id}`} />, root);
    const link = await waitFor(() => root.querySelector<HTMLAnchorElement>(".rb-alert a"));
    expect(link.href).toMatch(/robulkAlert=/);
  });
});
