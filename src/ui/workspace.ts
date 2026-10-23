import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listCreators } from "../api/account";
import { listAvatarItems } from "../api/catalog";
import { listUnpublishedClothing, type UnpublishedItem } from "../api/creations";
import { EXPERIENCE_CREATOR_SHARE, getBalance, getCreatorSplitPercent, listSales } from "../api/economy";
import { listDevProducts, listExperiences, listGamePasses } from "../api/experiences";
import { createClient, type RobloxClient } from "../api/http";
import { getThumbnails } from "../api/thumbnails";
import type { Creator, Experience, SellableItem } from "../api/types";
import { summarize, type Bucket, type EarningsSummary, type SaleTransaction } from "../core/earnings";
import type { Edit } from "../core/edits";
import { History, chromeStorage, memoryStorage } from "../core/history";
import { SalesCache, cacheCovers, mergeFetched, mergeOlder, planFetch, type SalesCacheEntry } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type Settings } from "../core/settings";
import { dashboardGroupId } from "./dashboardGroup";

// Everything the tabs share: who we're working on, their items, unsaved
// edits, sales data and history. Lives in the panel shell.

export const creatorKey = (c: Creator) => `${c.type}:${c.id}`;
const splitKey = (assetType: number, price: number) => `${assetType}:${price}`;

const DAY = 86_400_000;
/** All time is charted by week once the history is longer than this. */
const WEEKLY_AFTER_DAYS = 90;

export type ReportRange = 7 | 30 | 90 | "all";

/**
 * Sales loaded during this page visit, per creator. They live as long as the
 * page does, so closing and reopening RoBulk, switching creators or moving
 * around the dashboard never asks Roblox again; Refresh (or reloading the
 * page) does.
 */
interface PageSales {
  sales: SalesCacheEntry;
  balance: number | null;
  loadedAt: Date;
}
const pageSales = new Map<string, PageSales>();
/** The report range last used on this page, so reopening RoBulk keeps it. */
let pageRange: ReportRange = 30;

/** Forgets this page visit's sales (for tests). */
export function forgetPageSales() {
  pageSales.clear();
  pageRange = 30;
}

export const rangeLabel = (range: ReportRange) => (range === "all" ? "all time" : `last ${range} days`);

export interface SalesState {
  range: ReportRange;
  /** Start of the period shown (for all time, the first sale or how far loading got). */
  since: string | null;
  loading: boolean;
  progress: string | null;
  /** How far the current load has got, 0 to 1, or null when there's no way to know. */
  fraction: number | null;
  error: string | null;
  truncated: boolean;
  current: EarningsSummary | null;
  previous: EarningsSummary | null;
  balance: number | null;
  loadedAt: Date | null;
}

/** Opens on the group the Creator Dashboard has selected, if the user can manage it. */
function initialCreator(creators: Creator[]): Creator {
  const groupId = dashboardGroupId(creators[0].id);
  return creators.find((c) => c.type === "Group" && c.id === groupId) ?? creators[0];
}

const makeStorage = () => (typeof chrome !== "undefined" && chrome.storage?.local ? chromeStorage() : memoryStorage());

/** `initialUniverseId` preselects an experience (used by the preview page); otherwise none is selected. */
export function useWorkspaceState(initialUniverseId: number | null = null) {
  const client = useMemo<RobloxClient>(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const history = useMemo(() => new History(storage), [storage]);
  const salesCache = useMemo(() => new SalesCache(storage), [storage]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /** The same settings, for async work that started before a change. */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  const [creators, setCreators] = useState<Creator[] | null>(null);
  const [creator, setCreator] = useState<Creator | null>(null);
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [universeId, setUniverseId] = useState<number | null>(null);

  const [avatarItems, setAvatarItems] = useState<SellableItem[]>([]);
  const [experienceItems, setExperienceItems] = useState<SellableItem[]>([]);
  const [loadingAvatar, setLoadingAvatar] = useState(true);
  const [loadingExperience, setLoadingExperience] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Clothing that was approved but never published (publishing costs Robux). */
  const [unpublished, setUnpublished] = useState<UnpublishedItem[]>([]);
  /** The creator being loaded, so late results for an earlier one are dropped. */
  const loadingCreator = useRef<Creator | null>(null);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [edits, setEdits] = useState<Map<string, Edit>>(new Map());
  /**
   * Percent of a marketplace sale the creator keeps, keyed by asset type and
   * price. Roblox's share is progressive (30% at the price floor, rising to
   * 70% at 6x the floor), so it has to be looked up per price.
   */
  const [splits, setSplits] = useState<Map<string, number>>(new Map());
  const splitRequests = useRef(new Set<string>());

  const [sales, setSales] = useState<SalesState>({
    range: pageRange, since: null, loading: false, progress: null, fraction: null, error: null, truncated: false, current: null, previous: null, balance: null, loadedAt: null,
  });
  const salesAbort = useRef<AbortController | null>(null);
  /** Set by "Stop": keep and show what was loaded instead of discarding it. */
  const salesStopped = useRef(false);
  const transactionsRef = useRef<SaleTransaction[]>([]);
  /** How far back the loaded sales are complete (null = the whole history). */
  const coverageRef = useRef<string | null>(null);
  /** Set once anything asks for sales, so switching creator reloads them. */
  const salesWanted = useRef(false);

  const items = useMemo(() => [...avatarItems, ...experienceItems], [avatarItems, experienceItems]);
  /** The latest items, for sales loads that started before they arrived. */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const experience = experiences.find((x) => x.universeId === universeId) ?? null;

  const addThumbnails = (list: SellableItem[]) => {
    getThumbnails(client, list).then((found) => setThumbs((prev) => new Map([...prev, ...found])));
  };

  /** Fetches the creator share for any asset type + price pairs not looked up yet. */
  const ensureSplits = (wanted: { item: SellableItem; price: number | null }[]) => {
    if (!settingsRef.current.perSaleEarnings) return;
    const todo = new Map<string, { item: SellableItem; price: number }>();
    for (const { item, price } of wanted) {
      if (item.kind !== "avatar" || price == null || price <= 0) continue;
      const key = splitKey(item.assetType ?? -1, price);
      if (!splitRequests.current.has(key) && !todo.has(key)) todo.set(key, { item, price });
    }
    if (todo.size === 0) return;
    for (const key of todo.keys()) splitRequests.current.add(key);
    const queue = [...todo.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, { item, price }] = next;
        const pct = await getCreatorSplitPercent(client, item.id, price);
        if (pct != null) setSplits((prev) => new Map(prev).set(key, pct));
        else splitRequests.current.delete(key); // allow a retry later
      }
    };
    for (let i = 0; i < Math.min(4, queue.length); i++) worker();
  };

  useEffect(() => {
    const settingsLoaded = readSettings(storage).then((s) => {
      settingsRef.current = s;
      setSettings(s);
    });
    listCreators(client)
      .then(async (list) => {
        await settingsLoaded;
        setCreators(list);
        setCreator(initialCreator(list));
      })
      .catch((e) => {
        setError(`Couldn't load your account: ${e.message}. Make sure you're logged in to Roblox.`);
        setLoadingAvatar(false);
      });
  }, []);

  const loadCreator = async (c: Creator) => {
    const reloadSales = salesWanted.current;
    loadingCreator.current = c;
    setLoadingAvatar(true);
    setError(null);
    setNotice(null);
    setUnpublished([]);
    setAvatarItems([]);
    setExperienceItems([]);
    setExperiences([]);
    setUniverseId(null);
    setEdits(new Map());
    setSplits(new Map());
    splitRequests.current.clear();
    salesAbort.current?.abort();
    transactionsRef.current = [];
    coverageRef.current = null;
    setSales((s) => ({ ...s, since: null, current: null, previous: null, balance: null, loadedAt: null, error: null, truncated: false, loading: false, progress: null }));

    const [avatarResult, experienceResult] = await Promise.allSettled([
      c.access.avatarItems ? listAvatarItems(client, c) : Promise.resolve([]),
      c.access.experiences ? listExperiences(client, c) : Promise.resolve([]),
    ]);
    if (avatarResult.status === "fulfilled") {
      setAvatarItems(avatarResult.value);
      addThumbnails(avatarResult.value);
      ensureSplits(avatarResult.value.map((item) => ({ item, price: item.price })));
      if (settingsRef.current.dailySnapshots) history.autoSnapshot(creatorKey(c), avatarResult.value).catch(() => {});
      // Only a warning, so a failed check just shows nothing.
      listUnpublishedClothing(client, c, new Set(avatarResult.value.map((i) => i.id)))
        .then((list) => loadingCreator.current === c && setUnpublished(list))
        .catch(() => {});
    } else {
      setError(`Couldn't load avatar items: ${avatarResult.reason?.message ?? avatarResult.reason}`);
    }
    if (experienceResult.status === "fulfilled") {
      setExperiences(experienceResult.value);
      setUniverseId(experienceResult.value.some((x) => x.universeId === initialUniverseId) ? initialUniverseId : null);
    } else {
      setNotice(`Couldn't load experiences, so Game Passes and Developer Products are hidden: ${experienceResult.reason?.message ?? experienceResult.reason}`);
    }
    if (!c.access.avatarItems) setNotice("Your role in this group can manage experiences but not avatar items, so only game passes, developer products and badges are shown.");
    setLoadingAvatar(false);
    // Bring back this page visit's sales for the creator (no request), or load them if
    // wanted. Unless that's switched off, they load in the background straight away.
    const background = settingsRef.current.backgroundSales && c.access.earnings;
    if (reloadSales || background || pageSales.has(creatorKey(c))) loadSales(pageRange, c);
  };

  useEffect(() => {
    if (creator) loadCreator(creator);
  }, [creator]);

  const loadExperience = async (id: number | null) => {
    setExperienceItems([]);
    if (id == null || !creator) return;
    setLoadingExperience(true);
    const [passes, products] = await Promise.allSettled([listGamePasses(client, id), listDevProducts(client, id)]);
    const loaded = [passes, products].flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const failed = [passes, products].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    setExperienceItems(loaded);
    addThumbnails(loaded);
    if (loaded.length && settingsRef.current.dailySnapshots) history.autoSnapshot(`${creatorKey(creator)}:universe:${id}`, loaded).catch(() => {});
    if (failed.length) setNotice(`Couldn't load some experience items: ${failed[0].reason?.message ?? failed[0].reason}`);
    setLoadingExperience(false);
  };

  useEffect(() => {
    loadExperience(universeId);
  }, [universeId]);

  /** Summarizes the loaded transactions for a range (and the period before it, for comparison). */
  const resummarize = (range: ReportRange, transactions = transactionsRef.current, coveredFrom = coverageRef.current) => {
    const now = new Date();
    const items = itemsRef.current;
    if (range === "all") {
      const first = coveredFrom ?? transactions.at(-1)?.created ?? now.toISOString();
      const bucket: Bucket = now.getTime() - new Date(first).getTime() > WEEKLY_AFTER_DAYS * DAY ? "week" : "day";
      return { since: first, current: summarize(transactions, new Date(first), now, items, bucket), previous: null };
    }
    const start = new Date(now.getTime() - (range - 1) * DAY);
    const prevEnd = new Date(start.getTime() - DAY);
    const prevStart = new Date(prevEnd.getTime() - (range - 1) * DAY);
    return { since: start.toISOString(), current: summarize(transactions, start, now, items), previous: summarize(transactions, prevStart, prevEnd, items) };
  };

  /**
   * Shows sales for a range. Sales already loaded on this page are reused
   * without asking Roblox; `force` (Refresh, Keep loading) fetches anyway.
   */
  const loadSales = async (range: ReportRange, forCreator: Creator | null = creator, { force = false }: { force?: boolean } = {}) => {
    if (!forCreator) return;
    salesWanted.current = true;
    pageRange = range;
    if (!forCreator.access.earnings) {
      setSales((s) => ({ ...s, range, error: "Your role in this group can't view its revenue, so earnings aren't available." }));
      return;
    }
    const memory = pageSales.get(creatorKey(forCreator));
    const wanted = range === "all" ? null : new Date(Date.now() - range * 2 * DAY);
    if (!force && memory && cacheCovers(memory.sales, wanted)) {
      salesAbort.current?.abort();
      transactionsRef.current = memory.sales.sales;
      coverageRef.current = memory.sales.coveredFrom;
      setSales((s) => ({
        ...s,
        range,
        ...resummarize(range, memory.sales.sales, memory.sales.coveredFrom),
        balance: memory.balance,
        truncated: false,
        loading: false,
        progress: null,
        fraction: null,
        error: null,
        loadedAt: memory.loadedAt,
      }));
      return;
    }
    salesAbort.current?.abort();
    salesStopped.current = false;
    const controller = new AbortController();
    salesAbort.current = controller;
    setSales((s) => ({ ...s, range, loading: true, error: null, progress: "Loading sales…", fraction: 0 }));
    try {
      const key = creatorKey(forCreator);
      const now = new Date();
      // Twice the range, so we can compare with the previous period; null = everything.
      const want = range === "all" ? null : new Date(now.getTime() - range * 2 * DAY);
      // This page's sales if any, otherwise what earlier visits saved in the browser.
      const remember = settingsRef.current.rememberSales;
      const cached = memory?.sales ?? (remember ? await salesCache.read(key) : null);
      if (controller.signal.aborted) return;
      if (cached && cacheCovers(cached, want)) {
        // Show what's cached straight away while the newest sales are fetched.
        transactionsRef.current = cached.sales;
        coverageRef.current = cached.coveredFrom;
        setSales((s) => ({ ...s, ...resummarize(range, cached.sales, cached.coveredFrom), truncated: false }));
      } else {
        // Not loaded this far back yet: show progress rather than the old range's numbers.
        setSales((s) => ({ ...s, current: null, previous: null }));
      }
      /** Pages back from `fromCursor` (or the newest sale) to `stopAt`, showing progress. */
      const fetchSales = (stopAt: Date | null, label: string, startsAt: Date, fromCursor?: string) => {
        const span = stopAt ? startsAt.getTime() - stopAt.getTime() : 0;
        return listSales(client, forCreator, stopAt, {
          maxPages: stopAt === null ? 5000 : 200,
          fromCursor,
          signal: controller.signal,
          onProgress: (p) =>
            setSales((s) => ({
              ...s,
              progress:
                label +
                `${p.sales.toLocaleString()} so far` +
                (p.oldest ? `, back to ${new Date(p.oldest).toLocaleDateString()}` : "") +
                (stopAt === null ? ". Only the first load takes this long." : ""),
              // Paging runs newest to oldest, so how far back it's got is how far along it is.
              fraction: span > 0 ? Math.min(1, p.oldest ? (startsAt.getTime() - new Date(p.oldest).getTime()) / span : 0) : null,
            })),
        });
      };
      const stopped = () => controller.signal.aborted && !salesStopped.current;

      // Going further back than what's loaded carries on from where the last
      // load stopped, instead of paging through those sales again.
      const resume = !!cached?.olderCursor && !cacheCovers(cached, want);
      // Sales from this visit only need the older part; saved ones also need what's new.
      const olderOnly = resume && !!memory;
      const balancePromise = olderOnly ? Promise.resolve(memory!.balance) : getBalance(client, forCreator);
      let merged = cached;
      if (!olderOnly) {
        const stopAt = resume ? planFetch(cached, new Date(cached!.coveredFrom!), now) : planFetch(cached, want, now);
        const label = stopAt === null ? "Loading your full sales history… " : "Loading sales… ";
        const fetched = await fetchSales(stopAt, label, now);
        if (stopped()) return;
        merged = mergeFetched(cached, fetched, stopAt, now);
      }
      if (resume && merged!.olderCursor && !controller.signal.aborted && !cacheCovers(merged!, want)) {
        try {
          const older = await fetchSales(want, "Loading older sales… ", new Date(merged!.coveredFrom!), merged!.olderCursor);
          if (stopped()) return;
          merged = mergeOlder(merged!, older, want);
        } catch {
          if (stopped()) return;
          if (!controller.signal.aborted) {
            // Roblox may not take a cursor from an earlier visit: page from the newest sale instead.
            const fetched = await fetchSales(want, want === null ? "Loading your full sales history… " : "Loading sales… ", now);
            if (stopped()) return;
            merged = mergeFetched(merged, fetched, want, now);
          }
        }
      }
      const balance = await balancePromise;
      merged = merged!;
      if (remember) await salesCache.write(key, merged);
      const loadedAt = olderOnly ? memory!.loadedAt : new Date();
      pageSales.set(key, { sales: merged, balance, loadedAt });
      transactionsRef.current = merged.sales;
      coverageRef.current = merged.coveredFrom;
      const incomplete = merged.coveredFrom !== null && (want === null || new Date(merged.coveredFrom) > want);
      setSales((s) => ({
        ...s,
        ...resummarize(range, merged.sales, merged.coveredFrom),
        balance,
        truncated: incomplete,
        loading: false,
        progress: null,
        fraction: null,
        loadedAt,
      }));
    } catch (e) {
      if (controller.signal.aborted && !salesStopped.current) return;
      setSales((s) => ({ ...s, loading: false, progress: null, fraction: null, error: `Couldn't load sales: ${(e as Error).message}` }));
    }
  };

  /** Stops a long sales load and shows what was loaded so far. */
  const stopSales = () => {
    salesStopped.current = true;
    salesAbort.current?.abort();
  };

  // Keep categories/names in the report in step with the loaded items.
  useEffect(() => {
    if (sales.loadedAt) setSales((s) => ({ ...s, ...resummarize(s.range) }));
  }, [items]);

  /** Saves a settings change and applies it straight away. */
  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    const before = settingsRef.current;
    settingsRef.current = next;
    setSettings(next);
    writeSettings(storage, next);
    if (before.rememberSales && !next.rememberSales) salesCache.clear().catch(() => {});
    if (!before.perSaleEarnings && next.perSaleEarnings) ensureSplits(avatarItems.map((item) => ({ item, price: item.price })));
  };

  /** What the creator gets from one sale at `price`, or null if unknown. */
  const earningsPerSale = (item: SellableItem, price: number | null): number | null => {
    if (price == null || !settings.perSaleEarnings) return null;
    if (price <= 0) return 0;
    const pct = item.kind === "avatar" ? splits.get(splitKey(item.assetType ?? -1, price)) : EXPERIENCE_CREATOR_SHARE;
    return pct == null ? null : Math.floor((price * pct) / 100);
  };

  return {
    client,
    history,
    creators,
    creator,
    setCreator,
    experiences,
    experience,
    universeId,
    setUniverseId,
    items,
    avatarItems,
    setAvatarItems,
    experienceItems,
    setExperienceItems,
    loading: loadingAvatar || loadingExperience,
    loadingExperience,
    error,
    notice,
    setNotice,
    unpublished,
    thumbs,
    edits,
    setEdits,
    reloadCreator: () => creator && loadCreator(creator),
    reloadExperience: () => loadExperience(universeId),
    sales,
    loadSales,
    stopSales,
    earningsPerSale,
    ensureSplits,
    settings,
    updateSettings,
    savedSalesSize: () => salesCache.size(),
    clearSavedSales: () => salesCache.clear(),
  };
}

export type Workspace = ReturnType<typeof useWorkspaceState>;

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside the RoBulk panel");
  return ws;
}
