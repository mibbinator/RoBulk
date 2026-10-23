// Puts a "RoBulk" entry in the Creator Dashboard's left sidebar, right under
// "All tools". The dashboard's class names are generated, so the entry is a
// copy of the All tools entry with our label and logo: it picks up the same
// look in every sidebar mode (full, compact, icons only) and theme.
//
// The sidebar is React and re-renders whenever its mode changes, so a
// MutationObserver re-copies the entry when All tools changes or ours is lost.
//
// One difference: the dashboard hides every label when the sidebar is
// collapsed to icons, but RoBulk's name always shows, as a caption under the
// logo when there's no room beside it.

export const ENTRY_ID = "robulk-sidebar-entry";
const STYLE_ID = "robulk-sidebar-style";

const STYLE = `
#${ENTRY_ID} { container-type: inline-size; }
#${ENTRY_ID} [data-robulk-label] { font-weight: 700 !important; }
@container (max-width: 100px) {
  #${ENTRY_ID} [data-robulk-button] {
    flex-direction: column !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 2px;
    width: 100% !important;
    height: auto !important;
    min-height: 40px !important;
    padding: 4px 0 !important;
  }
  #${ENTRY_ID} [data-robulk-button] > * { margin: 0 !important; padding: 0 !important; }
  #${ENTRY_ID} [data-robulk-label] {
    opacity: 1 !important;
    max-width: none !important;
    padding: 0 !important;
    font-size: 11px !important;
    line-height: 14px !important;
    white-space: nowrap !important;
  }
}`;

const ALL_TOOLS_ICON = '[class*="icon-regular-three-dots-horizontal"]';
/** The Creations entry, which only the sidebar's own entries sit next to. */
const CREATIONS_ENTRY = ':scope > :is(a, button) :is([class*="icon-regular-folder"], [class*="icon-filled-folder"])';

/** The wrapper around the All tools button, if the sidebar is showing. */
export function findAllToolsEntry(doc: Document): HTMLElement | null {
  const byIcon = [...doc.querySelectorAll(ALL_TOOLS_ICON)].map((el) => el.closest("a, button"));
  // English fallback, in case the icon is ever renamed.
  const byLabel = [...doc.querySelectorAll("a, button")].filter((b) => b.textContent?.trim() === "All tools");
  // Entries are wrapper divs side by side, each holding one button or link.
  for (const button of [...byIcon, ...byLabel]) {
    const wrapper = button?.parentElement;
    const siblings = wrapper?.parentElement ? [...wrapper.parentElement.children] : [];
    if (wrapper && siblings.some((el) => el !== wrapper && el.querySelector(CREATIONS_ENTRY))) return wrapper;
  }
  return null;
}

/** What our copy was made from; when this changes, the copy is out of date. */
const signature = (wrapper: HTMLElement) =>
  [wrapper, ...wrapper.querySelectorAll("*")].map((el) => (el instanceof SVGElement ? "" : el.className)).join("|");

function buildEntry(allTools: HTMLElement, logoUrl: string, onOpen: () => void): HTMLElement {
  const entry = allTools.cloneNode(true) as HTMLElement;
  for (const el of [entry, ...entry.querySelectorAll("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("aria-describedby");
    el.removeAttribute("aria-label");
  }
  entry.id = ENTRY_ID;
  entry.dataset.robulkFrom = signature(allTools);

  const button = entry.querySelector<HTMLElement>("a, button")!;
  button.removeAttribute("href");
  if (button instanceof HTMLButtonElement) button.type = "button";
  button.dataset.robulkButton = "";
  button.title = "RoBulk";
  button.setAttribute("aria-label", "Open RoBulk");
  button.addEventListener("click", (e) => {
    e.preventDefault();
    onOpen();
  });

  // MUI puts the icon in a "startIcon" span and the label in a Typography element.
  const iconSlot = button.querySelector('[class*="startIcon"]') ?? button.firstElementChild;
  if (iconSlot) {
    const logo = document.createElement("img");
    logo.src = logoUrl;
    logo.alt = "";
    logo.width = 24;
    logo.height = 24;
    logo.style.cssText = "display:block;width:24px;height:24px;border-radius:6px";
    iconSlot.replaceChildren(logo);
  }
  const label = [...button.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() && el !== iconSlot);
  if (label instanceof HTMLElement) {
    label.textContent = "RoBulk";
    label.dataset.robulkLabel = "";
  }
  return entry;
}

/** Adds the entry if it's missing or stale. True when it's in the sidebar. */
export function syncSidebarEntry(doc: Document, logoUrl: string, onOpen: () => void): boolean {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
  }
  const allTools = findAllToolsEntry(doc);
  const existing = doc.getElementById(ENTRY_ID);
  if (!allTools) {
    existing?.remove();
    return false;
  }
  if (existing && existing.previousElementSibling === allTools && existing.dataset.robulkFrom === signature(allTools)) return true;
  existing?.remove();
  allTools.after(buildEntry(allTools, logoUrl, onOpen));
  return true;
}

/** Keeps the entry in place until the returned function is called. `onChange` says whether it's showing. */
export function watchSidebar(logoUrl: string, onOpen: () => void, onChange: (shown: boolean) => void): () => void {
  let queued = false;
  let shown: boolean | null = null;
  const sync = () => {
    queued = false;
    const now = syncSidebarEntry(document, logoUrl, onOpen);
    if (now !== shown) onChange((shown = now));
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
  return () => {
    observer.disconnect();
    document.getElementById(ENTRY_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}
