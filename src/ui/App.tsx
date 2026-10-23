import { useEffect, useMemo, useState } from "preact/hooks";
import logoUrl from "../../public/icons/icon-48.png?inline";
import { cachedCreators } from "../api/account";
import { universeFromPath } from "../api/games";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { readAlerts, type OffSaleAlert } from "../core/offSaleWatch";
import { extensionOverflowStore } from "../core/overflowStore";
import { SalesCache } from "../core/salesCache";
import { SEEN_CHANGED, readSeen, salesSince } from "../core/seenSales";
import { readSettings } from "../core/settings";
import { ENTRY_ID, OVERVIEW_ID, setSidebarBadge, setSidebarProgress, watchSidebar } from "../content/sidebar";
import { AccountOverview } from "./AccountOverview";
import { robux } from "./charts";
import { OffSaleBanner, runOffSaleCheck } from "./OffSaleBanner";
import { onPageLoadingChange, pageLoading, salesLoader } from "./salesLoader";
import { Shell, type TabId } from "./Shell";
import { detectTheme, type Theme } from "./theme";
import { creatorKey, initialCreator, makeStorage, type Opening } from "./workspace";

// The dashboard is a single-page app, so watch for route changes and only
// offer RoBulk on dashboard pages.
const isDashboard = () => location.pathname.startsWith("/dashboard");

/** How long to wait for the sidebar before showing the floating button instead. */
const SIDEBAR_WAIT_MS = 4000;
const DAY = 86_400_000;

/** A chart in RoBulk's blue square, for the Account Overview entry. */
const overviewIcon =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#335fff"/><rect x="5.5" y="12" width="3" height="7" rx="1" fill="#fff"/><rect x="10.5" y="8" width="3" height="11" rx="1" fill="#fff"/><rect x="15.5" y="5" width="3" height="14" rx="1" fill="#fff"/></svg>`,
  );

type Open = { kind: "robulk"; tab?: TabId; opening?: Opening } | { kind: "overview" } | null;

export function App() {
  const [onDashboard, setOnDashboard] = useState(isDashboard);
  const [open, setOpen] = useState<Open>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [inSidebar, setInSidebar] = useState(false);
  const [waited, setWaited] = useState(false);
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);

  useEffect(() => {
    const id = setInterval(() => setOnDashboard(isDashboard()), 1000);
    const wait = setTimeout(() => setWaited(true), SIDEBAR_WAIT_MS);
    return () => {
      clearInterval(id);
      clearTimeout(wait);
    };
  }, []);

  const show = (next: Open) => {
    setTheme(detectTheme());
    setOpen(next);
  };
  /** Opens RoBulk on the experience whose dashboard page this is, or on the clothing store. */
  const openRoBulk = () => show({ kind: "robulk", opening: { universeId: universeFromPath(location.pathname) ?? undefined } });
  const review = (alert: OffSaleAlert) => show({ kind: "robulk", opening: { creatorKey: alert.creatorKey, stageOnSale: alert.items.map((i) => i.id) } });

  // RoBulk's entries under "All tools" in the dashboard's sidebar.
  useEffect(() => {
    if (!onDashboard) return;
    return watchSidebar(
      [
        { id: ENTRY_ID, label: "RoBulk", ariaLabel: "Open RoBulk", iconUrl: logoUrl, onOpen: openRoBulk },
        { id: OVERVIEW_ID, label: "Account Overview", shortLabel: "Overview", ariaLabel: "Open RoBulk's account overview", iconUrl: overviewIcon, onOpen: () => show({ kind: "overview" }) },
      ],
      setInSidebar,
    );
  }, [onDashboard]);

  // Sales keep loading after RoBulk is closed; the sidebar entry shows how far along they are.
  useEffect(() => {
    const update = () => setSidebarProgress(document, pageLoading());
    update();
    return onPageLoadingChange(update);
  }, []);

  // Look for items that went off sale, and open the fix straight away when sent here from roblox.com.
  useEffect(() => {
    if (!onDashboard) return;
    runOffSaleCheck(client, storage);
    const fromRoblox = new URLSearchParams(location.search).get("robulkAlert");
    if (fromRoblox) {
      readAlerts(storage).then((alerts) => {
        const alert = alerts.find((a) => a.id === fromRoblox);
        if (alert) review(alert);
      });
    }
  }, [onDashboard]);

  // New sales since the Earnings report was last opened, counted on the sidebar entry
  // for the group the dashboard has selected.
  useEffect(() => {
    if (!onDashboard) return;
    let stop = () => {};
    let cancelled = false;
    (async () => {
      const settings = await readSettings(storage);
      if (!settings.newSalesBadge && !settings.backgroundSales) return;
      const creators = await cachedCreators(client, storage).catch(() => [] as Creator[]);
      if (cancelled || creators.length === 0) return;
      const creator = initialCreator(creators);
      if (!creator.access.earnings) return;
      const key = creatorKey(creator);
      const cache = new SalesCache(storage, { maxSales: () => settings.maxStoredSales, overflow: extensionOverflowStore() });
      const loader = salesLoader(creator, client, cache, () => settings.rememberSales);
      if (settings.backgroundSales) loader.load(new Date(Date.now() - 60 * DAY));
      if (!settings.newSalesBadge) return;

      let seen: string | null = await readSeen(storage, key);
      const update = () => {
        const sales = loader.state.entry?.sales;
        const fresh = seen && sales ? salesSince(sales, seen) : { count: 0, robux: 0 };
        setSidebarBadge(
          document,
          fresh.count > 0
            ? {
                text: `+${fresh.count > 99 ? "99+" : fresh.count}`,
                title: `${fresh.count.toLocaleString()} new ${fresh.count === 1 ? "sale" : "sales"} (${robux(fresh.robux)}) in ${creator.name} since you last opened the Earnings report`,
              }
            : null,
        );
      };
      const onSeen = async () => {
        seen = await readSeen(storage, key);
        update();
      };
      const off = loader.subscribe(update);
      window.addEventListener(SEEN_CHANGED, onSeen);
      update();
      stop = () => {
        off();
        window.removeEventListener(SEEN_CHANGED, onSeen);
        setSidebarBadge(document, null);
      };
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onDashboard]);

  // When the sidebar is hidden (small windows) or can't be found, a floating button stands in.
  const floating = onDashboard && !open && !inSidebar && waited;

  return (
    <div class="rb-root" data-theme={theme}>
      {onDashboard && <OffSaleBanner site="dashboard" storage={storage} onReview={review} />}
      {floating && (
        <button class="rb-launcher" onClick={openRoBulk} title="Open RoBulk">
          <img src={logoUrl} alt="" width={20} height={20} />
          RoBulk
        </button>
      )}
      {open?.kind === "robulk" && (
        <Shell onClose={() => setOpen(null)} initialTab={open.tab} opening={open.opening} onOpenOverview={() => show({ kind: "overview" })} />
      )}
      {open?.kind === "overview" && (
        <AccountOverview onClose={() => setOpen(null)} onOpenCreator={(c) => show({ kind: "robulk", tab: "earnings", opening: { creatorKey: creatorKey(c) } })} />
      )}
    </div>
  );
}
