// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTRY_ID, findAllToolsEntry, setSidebarProgress, syncSidebarEntry } from "./sidebar";

// A cut-down copy of the Creator Dashboard's sidebar: each entry is a wrapper
// div around an MUI button with a startIcon span and a Typography label.
const entry = (icon: string, label: string, extra = "") => `
  <div class="tss-wrap ${extra}">
    <button class="MuiButton-root tss-item" aria-label="${label}">
      <span class="MuiButton-startIcon"><span class="${icon}"></span></span>
      <span class="MuiTypography-root tss-label">${label}</span>
    </button>
  </div>`;

function sidebar() {
  document.body.innerHTML = `
    <main><button><span class="icon-regular-three-dots-horizontal"></span>More</button></main>
    <nav id="rail">
      ${entry("icon-regular-folder", "Creations")}
      ${entry("icon-regular-three-dots-horizontal", "All tools")}
      ${entry("roblox-icon", "Roblox website", "tss-bottom")}
    </nav>`;
  return document.getElementById("rail")!;
}

afterEach(() => {
  setSidebarProgress(document, null);
  document.body.innerHTML = "";
});

describe("sidebar entry", () => {
  it("goes right under All tools, labelled RoBulk with the logo, and opens RoBulk", () => {
    const rail = sidebar();
    const onOpen = vi.fn();

    expect(syncSidebarEntry(document, "data:image/png;base64,AA", onOpen)).toBe(true);

    const labels = [...rail.children].map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Creations", "All tools", "RoBulk", "Roblox website"]);
    const ours = document.getElementById(ENTRY_ID)!;
    expect(ours.querySelector(".MuiButton-startIcon img")!.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(ours.querySelector("button")!.getAttribute("aria-label")).toBe("Open RoBulk");
    expect(ours.querySelector(".tss-label")!.textContent).toBe("RoBulk"); // keeps the dashboard's label styling

    ours.querySelector("button")!.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("ignores the same icon outside the sidebar", () => {
    sidebar();
    expect(findAllToolsEntry(document)!.textContent?.trim()).toBe("All tools");
  });

  it("doesn't add a second copy, and re-copies when the sidebar changes mode", () => {
    const rail = sidebar();
    syncSidebarEntry(document, "logo", () => {});
    const first = document.getElementById(ENTRY_ID);
    syncSidebarEntry(document, "logo", () => {});
    expect(document.getElementById(ENTRY_ID)).toBe(first);

    // Collapsing the sidebar swaps the entries' classes.
    rail.querySelectorAll("button").forEach((b) => b.classList.add("tss-icon-only"));
    syncSidebarEntry(document, "logo", () => {});
    const second = document.getElementById(ENTRY_ID)!;
    expect(second).not.toBe(first);
    expect(second.querySelector("button")!.classList.contains("tss-icon-only")).toBe(true);
    expect(rail.querySelectorAll(`#${ENTRY_ID}`)).toHaveLength(1);
  });

  it("puts the entry back if the dashboard removes it", () => {
    sidebar();
    syncSidebarEntry(document, "logo", () => {});
    document.getElementById(ENTRY_ID)!.remove();
    expect(syncSidebarEntry(document, "logo", () => {})).toBe(true);
    expect(document.getElementById(ENTRY_ID)).not.toBeNull();
  });

  it("says when there's no sidebar to go in", () => {
    document.body.innerHTML = "<main>Loading…</main>";
    expect(syncSidebarEntry(document, "logo", () => {})).toBe(false);
  });

  it("always shows its name, even when the dashboard hides the other labels", () => {
    sidebar();
    syncSidebarEntry(document, "logo", () => {});
    const label = document.querySelector<HTMLElement>(`#${ENTRY_ID} [data-robulk-label]`)!;
    expect(label.textContent).toBe("RoBulk");
    // A container query in the injected style turns it into a caption when the sidebar is narrow.
    expect(document.getElementById("robulk-sidebar-style")!.textContent).toContain("@container");
    expect(document.querySelectorAll("#robulk-sidebar-style")).toHaveLength(1);
    syncSidebarEntry(document, "logo", () => {});
    expect(document.querySelectorAll("#robulk-sidebar-style")).toHaveLength(1);
  });

  it("works when All tools is a link rather than a button", () => {
    document.body.innerHTML = `<nav>
      <div><a href="/creations"><span class="MuiButton-startIcon"><span class="icon-regular-folder"></span></span><span><span>Creations</span></span></a></div>
      <div><a href="/tools"><span class="MuiButton-startIcon"><span class="icon-regular-three-dots-horizontal"></span></span><span><span>All tools</span></span></a></div>
    </nav>`;
    expect(syncSidebarEntry(document, "logo", () => {})).toBe(true);
    const link = document.querySelector(`#${ENTRY_ID} a`)!;
    expect(link.hasAttribute("href")).toBe(false); // clicking opens RoBulk instead of navigating
    expect(link.textContent?.trim()).toBe("RoBulk");
  });
  it("shows a progress bar while sales load, and keeps it when the entry is re-copied", () => {
    const rail = sidebar();
    syncSidebarEntry(document, "logo", () => {});
    const bar = () => document.querySelector<HTMLElement>(`#${ENTRY_ID} [data-robulk-progress]`);
    expect(bar()).toBeNull();

    setSidebarProgress(document, { fraction: 0.4, label: "Loading sales… 400 so far" });
    expect((bar()!.firstElementChild as HTMLElement).style.width).toBe("40%");
    expect(bar()!.getAttribute("aria-valuenow")).toBe("40");
    expect(document.querySelector(`#${ENTRY_ID} button`)!.getAttribute("title")).toBe("RoBulk: Loading sales… 400 so far");

    // All time can't say how far along it is.
    setSidebarProgress(document, { fraction: null, label: "Loading your full sales history…" });
    expect(bar()!.classList.contains("is-indeterminate")).toBe(true);

    // Collapsing the sidebar re-copies the entry; the bar comes with it.
    rail.querySelectorAll("button").forEach((b) => b.classList.add("tss-icon-only"));
    syncSidebarEntry(document, "logo", () => {});
    expect(bar()).not.toBeNull();

    setSidebarProgress(document, null);
    expect(bar()).toBeNull();
    expect(document.querySelector(`#${ENTRY_ID} button`)!.getAttribute("title")).toBe("RoBulk");
  });
});
