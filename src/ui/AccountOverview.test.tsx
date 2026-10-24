// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../core/history";
import { writeOverview, type OverviewRow } from "../core/overviewCache";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../core/settings";
import { AccountOverview } from "./AccountOverview";
import { fallbackStorage } from "./workspace";

const row: OverviewRow = {
  creator: { type: "Group", id: 9, name: "Test Group", access: { avatarItems: true, experiences: true, earnings: true }, owned: true },
  owned: true,
  percent: 100,
  periods: { 7: { cur: 12, prev: 6, pending: 0 }, 30: { cur: 40, prev: 30, pending: 0 }, 90: { cur: 1234, prev: 800, pending: 3 } },
  all: null,
  recentDone: true,
  balance: 250,
  asOf: "2026-10-20T12:00:00.000Z",
};

const settle = () => new Promise((r) => setTimeout(r, 20));

async function open(remember: boolean) {
  const storage = memoryStorage();
  fallbackStorage.current = storage;
  await writeSettings(storage, { ...DEFAULT_SETTINGS, rememberOverview: remember });
  await writeOverview(storage, [row]);
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchImpl);
  const root = document.createElement("div");
  document.body.append(root);
  render(<AccountOverview onClose={() => {}} onOpenCreator={() => {}} />, root);
  await settle();
  return { root, fetchImpl, storage };
}

afterEach(() => {
  fallbackStorage.current = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AccountOverview", () => {
  it("shows the saved report straight away, without asking Roblox", async () => {
    const { root, fetchImpl } = await open(true);
    expect(root.textContent).toContain("Showing the report saved");
    expect(root.textContent).toContain("Test Group");
    expect(root.textContent).toContain("1,234");
    expect(root.textContent).not.toContain("Press Run report");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("starts empty when remembering the overview is off", async () => {
    const { root } = await open(false);
    expect(root.textContent).not.toContain("Test Group");
    expect(root.textContent).toContain("Run report");
  });

  it("offers to remember the report when one is run with the setting off", async () => {
    const { root, storage } = await open(false);
    const button = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
    button("Run report").click();
    await settle();
    expect(root.textContent).toContain("This report won't be kept");
    button("Remember it").click();
    await settle();
    expect((await readSettings(storage)).rememberOverview).toBe(true);
    expect(root.textContent).not.toContain("This report won't be kept");
  });
});
