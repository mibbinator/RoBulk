// Puts RoBulk's entries ("RoBulk" and "Account Overview") in the Creator
// Dashboard's left sidebar, right under "All tools". The dashboard's class
// names are generated, so each entry is a copy of the All tools entry with our
// label and icon: it picks up the same look in every sidebar mode (full,
// compact, icons only) and theme.
//
// The sidebar is React and re-renders whenever its mode changes, so a
// MutationObserver re-copies the entries when All tools changes or ours are lost.
//
// One difference: the dashboard hides every label when the sidebar is
// collapsed to icons, but our names always show, as a caption under the icon
// when there's no room beside it. While sales load in the background, a thin
// progress bar runs along the bottom of the RoBulk entry, and a badge counts
// new sales.

export const ENTRY_ID = "robulk-sidebar-entry";
export const OVERVIEW_ID = "robulk-sidebar-overview";
const STYLE_ID = "robulk-sidebar-style";

const STYLE = `
[data-robulk-entry] { container-type: inline-size; position: relative; overflow: visible !important; }
[data-robulk-entry] [data-robulk-progress] {
  position: absolute;
  z-index: 1;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(128, 128, 128, 0.3);
  pointer-events: none;
}
[data-robulk-entry] [data-robulk-progress] > div {
  height: 100%;
  border-radius: inherit;
  background: #335fff;
  transition: width 0.3s ease-out;
}
[data-robulk-entry] [data-robulk-progress].is-indeterminate > div {
  width: 30%;
  animation: robulk-slide 1.2s ease-in-out infinite;
}
@keyframes robulk-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(340%); }
}
@media (prefers-reduced-motion: reduce) {
  [data-robulk-entry] [data-robulk-progress].is-indeterminate > div { width: 100%; opacity: 0.5; animation: none; }
}
/*
 * Our names always show. The copied classes can say "hidden" (the sidebar
 * fades labels out while it starts up and when it's collapsed), so override
 * that on the label and the span around it.
 */
[data-robulk-entry] [data-robulk-label],
[data-robulk-entry] [data-robulk-button] > :has([data-robulk-label]) {
  opacity: 1 !important;
  max-width: none !important;
  overflow: visible !important;
  visibility: visible !important;
}
[data-robulk-entry] [data-robulk-label] { font-weight: 700 !important; }
@container (min-width: 101px) {
  [data-robulk-entry] [data-robulk-label] { padding-left: 20px !important; }
}
[data-robulk-entry] [data-robulk-short] { display: none; }
[data-robulk-entry] [data-robulk-badge] {
  margin-left: auto !important;
  padding: 0 7px !important;
  border-radius: 999px;
  background: #3cb46e;
  color: #fff;
  font: 700 11px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
@container (max-width: 100px) {
  [data-robulk-entry] [data-robulk-button] {
    flex-direction: column !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 2px;
    width: 100% !important;
    height: auto !important;
    min-height: 40px !important;
    padding: 4px 0 !important;
  }
  [data-robulk-entry] [data-robulk-button] > :not([data-robulk-badge]) { margin: 0 !important; padding: 0 !important; }
  [data-robulk-entry] [data-robulk-progress] { left: 0; right: 0; bottom: -2px; }
  [data-robulk-entry] [data-robulk-label] {
    opacity: 1 !important;
    max-width: none !important;
    padding: 0 !important;
    font-size: 11px !important;
    line-height: 14px !important;
    white-space: nowrap !important;
  }
  [data-robulk-entry] [data-robulk-full] { display: none; }
  [data-robulk-entry] [data-robulk-short] { display: inline; }
  [data-robulk-entry] [data-robulk-badge] {
    position: absolute;
    top: 0;
    right: -2px;
    margin: 0 !important;
    padding: 0 4px !important;
    font-size: 10px;
    line-height: 15px;
  }
}`;

const ALL_TOOLS_ICON = '[class*="icon-regular-three-dots-horizontal"]';
/** The Creations entry, which only the sidebar's own entries sit next to. */
const CREATIONS_ENTRY = ':scope > :is(a, button) :is([class*="icon-regular-folder"], [class*="icon-filled-folder"])';

export interface SidebarEntry {
  id: string;
  label: string;
  /** Shown instead of `label` when the sidebar is collapsed and there's little room. */
  shortLabel?: string;
  /** What a screen reader announces for it. */
  ariaLabel: string;
  iconUrl: string;
  onOpen: () => void;
}

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

function buildEntry(allTools: HTMLElement, spec: SidebarEntry): HTMLElement {
  const entry = allTools.cloneNode(true) as HTMLElement;
  for (const el of [entry, ...entry.querySelectorAll("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("aria-describedby");
    el.removeAttribute("aria-label");
  }
  entry.id = spec.id;
  entry.dataset.robulkEntry = "";
  entry.dataset.robulkFrom = signature(allTools);

  const button = entry.querySelector<HTMLElement>("a, button")!;
  button.removeAttribute("href");
  if (button instanceof HTMLButtonElement) button.type = "button";
  button.dataset.robulkButton = "";
  button.title = spec.label;
  button.setAttribute("aria-label", spec.ariaLabel);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    spec.onOpen();
  });

  // MUI puts the icon in a "startIcon" span and the label in a Typography element.
  const iconSlot = button.querySelector('[class*="startIcon"]') ?? button.firstElementChild;
  if (iconSlot) {
    const icon = document.createElement("img");
    icon.src = spec.iconUrl;
    icon.alt = "";
    icon.width = 24;
    icon.height = 24;
    icon.style.cssText = "display:block;width:24px;height:24px;border-radius:6px";
    iconSlot.replaceChildren(icon);
  }
  // Found by where it sits, not by its text: when the dashboard first loads, its
  // labels are empty until its translations arrive, and filling them in later
  // only changes text, which wouldn't make us copy the entry again.
  const outsideIcon = (el: Element) => !iconSlot?.contains(el);
  let label: HTMLElement | undefined =
    [...button.querySelectorAll<HTMLElement>('[class*="MuiTypography"]')].find(outsideIcon) ??
    [...button.querySelectorAll<HTMLElement>("*")].filter((el) => el.children.length === 0 && outsideIcon(el) && !(el instanceof HTMLImageElement)).at(-1);
  if (!label) {
    label = document.createElement("span");
    label.style.paddingLeft = "20px";
    button.append(label);
  }
  label.dataset.robulkLabel = "";
  if (spec.shortLabel) {
    const full = document.createElement("span");
    full.dataset.robulkFull = "";
    full.textContent = spec.label;
    const short = document.createElement("span");
    short.dataset.robulkShort = "";
    short.textContent = spec.shortLabel;
    label.replaceChildren(full, short);
  } else label.textContent = spec.label;
  if (spec.id === ENTRY_ID) {
    showProgress(entry);
    showBadge(entry);
  }
  return entry;
}

export interface SidebarProgress {
  /** 0 to 1, or null to show that something is loading without saying how far. */
  fraction: number | null;
  label: string;
}

/** What the RoBulk entry should show; kept so a re-copied entry gets it straight away. */
let progress: SidebarProgress | null = null;
let badge: { text: string; title: string } | null = null;

function showProgress(entry: HTMLElement) {
  const button = entry.querySelector<HTMLElement>("[data-robulk-button]");
  let bar = entry.querySelector<HTMLElement>("[data-robulk-progress]");
  if (!progress) {
    bar?.remove();
    if (button) button.title = "RoBulk";
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.dataset.robulkProgress = "";
    bar.setAttribute("role", "progressbar");
    bar.append(document.createElement("div"));
    entry.append(bar);
  }
  const indeterminate = progress.fraction == null;
  bar.classList.toggle("is-indeterminate", indeterminate);
  (bar.firstElementChild as HTMLElement).style.width = indeterminate ? "" : `${Math.round(progress.fraction! * 100)}%`;
  if (indeterminate) bar.removeAttribute("aria-valuenow");
  else bar.setAttribute("aria-valuenow", String(Math.round(progress.fraction! * 100)));
  bar.setAttribute("aria-label", progress.label);
  if (button) button.title = `RoBulk: ${progress.label}`;
}

function showBadge(entry: HTMLElement) {
  const button = entry.querySelector<HTMLElement>("[data-robulk-button]");
  let pill = entry.querySelector<HTMLElement>("[data-robulk-badge]");
  if (!badge || !button) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement("span");
    pill.dataset.robulkBadge = "";
    button.append(pill);
  }
  pill.textContent = badge.text;
  pill.title = badge.title;
}

/** Shows a background load on the RoBulk entry, or clears it with null. */
export function setSidebarProgress(doc: Document, next: SidebarProgress | null) {
  progress = next;
  const entry = doc.getElementById(ENTRY_ID);
  if (entry) showProgress(entry);
}

/** Shows a small count on the RoBulk entry (like "+12"), or clears it with null. */
export function setSidebarBadge(doc: Document, next: { text: string; title: string } | null) {
  badge = next;
  const entry = doc.getElementById(ENTRY_ID);
  if (entry) showBadge(entry);
}

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  doc.head.append(style);
}

/** Adds the entries, in order under All tools, if any are missing or stale. True when they're in the sidebar. */
export function syncSidebarEntries(doc: Document, entries: SidebarEntry[]): boolean {
  ensureStyle(doc);
  const allTools = findAllToolsEntry(doc);
  if (!allTools) {
    for (const e of entries) doc.getElementById(e.id)?.remove();
    return false;
  }
  const from = signature(allTools);
  let previous: HTMLElement = allTools;
  for (const spec of entries) {
    const existing = doc.getElementById(spec.id);
    if (existing && existing.previousElementSibling === previous && existing.dataset.robulkFrom === from) {
      previous = existing;
      continue;
    }
    existing?.remove();
    const entry = buildEntry(allTools, spec);
    previous.after(entry);
    previous = entry;
  }
  return true;
}

/** Just the RoBulk entry. */
export function syncSidebarEntry(doc: Document, logoUrl: string, onOpen: () => void): boolean {
  return syncSidebarEntries(doc, [{ id: ENTRY_ID, label: "RoBulk", ariaLabel: "Open RoBulk", iconUrl: logoUrl, onOpen }]);
}

/** Keeps the entries in place until the returned function is called. `onChange` says whether they're showing. */
export function watchSidebar(entries: SidebarEntry[], onChange: (shown: boolean) => void): () => void {
  let queued = false;
  let shown: boolean | null = null;
  const sync = () => {
    queued = false;
    const now = syncSidebarEntries(document, entries);
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
    for (const e of entries) document.getElementById(e.id)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}
