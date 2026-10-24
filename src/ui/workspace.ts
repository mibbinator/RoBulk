import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listCreators } from "../api/account";
import { listAvatarItems } from "../api/catalog";
import { listUnpublishedClothing, type UnpublishedItem } from "../api/creations";
import { EXPERIENCE_CREATOR_SHARE, getCreatorSplitPercent } from "../api/economy";
import { listDevProducts, listExperiences, listGamePasses } from "../api/experiences";
import { createClient, type RobloxClient } from "../api/http";
import { getGameStats, type GameStats } from "../api/games";
import { getThumbnails } from "../api/thumbnails";
import type { Creator, Experience, SellableItem } from "../api/types";
import { summarize, transactionItemKey, type Bucket, type EarningsSummary, type SaleTransaction } from "../core/earnings";
import { setEdits as stageEdits, type Edit } from "../core/edits";
import { History, chromeStorage, memoryStorage, type StorageLike } from "../core/history";
import { rememberOnSale } from "../core/offSaleWatch";
import { extensionOverflowStore } from "../core/overflowStore";
import { SalesCache, cacheCovers } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type Settings } from "../core/settings";
import { dashboardGroupId } from "./dashboardGroup";
import { forgetSalesLoaders, salesLoader, type LoaderState, type SalesLoader } from "./salesLoader";

// Everything the tabs share: who we're working on, their items, unsaved
// edits, sales data and history. Lives in the panel shell.
//
// RoBulk shows one thing at a time: the creator's clothing store (avatar
// items), or one experience (its game passes and developer products, its
// stats, and the sales of those). The experience menu switches between them.

export const creatorKey = (c: Creator) => `${c.type}:${c.id}`;
const splitKey = (assetType: number, price: number) => `${assetType}:${price}`;

const DAY = 86_400_000;
/** All time is charted by week once the history is longer than this. */
const WEEKLY_AFTER_DAYS = 90;

export type ReportRange = 7 | 30 | 90 | "all";

// Sales are loaded per creator by a SalesLoader (see salesLoader.ts), which
// lives as long as the page does: closing and reopening RoBulk, switching
// creators or moving around the dashboard never asks Roblox again; Refresh
// (or reloading the page) does.

/** The report range last used on this page, so reopening RoBulk keeps it. */
let pageRange: ReportRange = 30;

/** Forgets this page visit's sales (for tests). */
export function forgetPageSales() {
  forgetSalesLoaders();
  pageRange = 30;
}

/** How far back a range needs sales: twice the range, to compare with the period before. null = everything. */
const salesWantedFor = (range: ReportRange, now = Date.now()) => (range === "all" ? null : new Date(now - range * 2 * DAY));

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
  /** Still loading back to the start of the range; the report shows what's in so far. */
  partial: boolean;
  /** The whole history is loaded, back to the first sale. */
  complete: boolean;
  current: EarningsSummary | null;
  previous: EarningsSummary | null;
  balance: number | null;
  loadedAt: Date | null;
}

/** Opens on the group the Creator Dashboard has selected, if the user can manage it. */
export function initialCreator(creators: Creator[], wanted?: string): Creator {
  const asked = wanted && creators.find((c) => creatorKey(c) === wanted);
  if (asked) return asked;
  const groupId = dashboardGroupId(creators[0].id);
  return creators.find((c) => c.type === "Group" && c.id === groupId) ?? creators[0];
}

/** Outside the extension, the preview page sets this so every part of RoBulk shares one pretend store. */
export const fallbackStorage: { current: StorageLike | null } = { current: null };

/** The extension's storage, or an in-memory stand-in on the preview page and in tests. */
export const makeStorage = (): StorageLike =>
  typeof chrome !== "undefined" && chrome.storage?.local ? chromeStorage() : (fallbackStorage.current ?? memoryStorage());

/** How RoBulk was asked to open: on a particular creator, with items to put back on sale. */
export interface Opening {
  creatorKey?: string;
  /** Open on this experience (and the creator who owns it), e.g. when RoBulk is opened from its dashboard page. */
  universeId?: number;
  /** Avatar item ids to stage "put on sale" for, once they've loaded. */
  stageOnSale?: number[];
}

/** `initialUniverseId` preselects an experience (used by the preview page); otherwise none is selected. */
export function useWorkspaceState(initialUniverseId: number | null = null, opening: Opening = {}) {
  const client = useMemo<RobloxClient>(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const history = useMemo(() => new History(storage), [storage]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /** The same settings, for async work that started before a change. */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const salesCache = useMemo(() => new SalesCache(storage, { maxSales: () => settingsRef.current.maxStoredSales, overflow: extensionOverflowStore() }), [storage]);

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

  const [range, setRange] = useState<ReportRange>(pageRange);
  /** The current creator's loader and what it has loaded. */
  const [loader, setLoader] = useState<SalesLoader | null>(null);
  const [loaded, setLoaded] = useState<LoaderState | null>(null);
  /** Shown instead of loading when the user's role can't see revenue. */
  const [salesBlocked, setSalesBlocked] = useState<string | null>(null);
  /** Set once anything asks for sales, so switching creator reloads them. */
  const salesWanted = useRef(false);
  const staged = useRef(false);

  /** What's on screen: the selected experience's passes and products, or the clothing store. */
  const items = useMemo(() => (universeId != null ? experienceItems : avatarItems), [universeId, avatarItems, experienceItems]);
  const pendingUniverse = useRef<number | null>(opening.universeId ?? initialUniverseId);

  /** The selected experience's public stats (visits, players, favorites, votes). */
  const [gameStats, setGameStats] = useState<GameStats | null>(null);
  useEffect(() => {
    setGameStats(null);
    if (universeId == null) return;
    let current = true;
    getGameStats(client, universeId)
      .then((g) => current && setGameStats(g))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [universeId]);

  /** The loaded sales that belong to what's on screen: the experience's passes and products, or the store's avatar items. */
  const scopedSales = useMemo((): SaleTransaction[] => {
    const all = loaded?.entry?.sales ?? [];
    if (universeId == null) return all.filter((t) => t.item.type !== "GamePass" && t.item.type !== "DeveloperProduct" && t.item.type !== "PrivateServer");
    // By the experience Roblox says a pass or product belongs to, or else by the experience's own passes and products.
    const keys = new Set(experienceItems.map((i) => i.key));
    return all.filter((t) => t.item.universeId === universeId || keys.has(transactionItemKey(t)));
  }, [loaded?.entry, universeId, experienceItems]);

  // Whatever RoBulk loads or saves is what the off-sale alarm compares against.
  useEffect(() => {
    if (creator && avatarItems.length) rememberOnSale(storage, creator, avatarItems).catch(() => {});
  }, [avatarItems]);
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
    // Opened on an experience: start on whoever owns it.
    const owner = opening.universeId && !opening.creatorKey ? getGameStats(client, opening.universeId).catch(() => null) : Promise.resolve(null);
    listCreators(client)
      .then(async (list) => {
        await settingsLoaded;
        const game = await owner;
        setCreators(list);
        setCreator(initialCreator(list, opening.creatorKey ?? (game ? `${game.creator.type}:${game.creator.id}` : undefined)));
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
    // A load for the previous creator carries on behind this one's instead of stopping (or starting over later).
    if (loader && loader.creator !== c) loader.demote();
    const next = c.access.earnings ? loaderFor(c) : null;
    setLoader(next);
    setLoaded(next?.state ?? null);
    setSalesBlocked(null);

    const [avatarResult, experienceResult] = await Promise.allSettled([
      c.access.avatarItems ? listAvatarItems(client, c) : Promise.resolve([]),
      c.access.experiences ? listExperiences(client, c) : Promise.resolve([]),
    ]);
    if (avatarResult.status === "fulfilled") {
      setAvatarItems(avatarResult.value);
      // Opened from an off-sale warning: stage those items back on sale, for review.
      if (opening.stageOnSale?.length && opening.creatorKey === creatorKey(c) && !staged.current) {
        staged.current = true;
        const ids = new Set(opening.stageOnSale);
        setEdits((prev) => stageEdits(prev, avatarResult.value.filter((i) => ids.has(i.id) && !i.onSale).map((item) => ({ item, patch: { onSale: true } }))));
      }
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
      // The experience RoBulk was opened on, the first time round; after that, the clothing store.
      const wanted = pendingUniverse.current;
      pendingUniverse.current = null;
      setUniverseId(experienceResult.value.some((x) => x.universeId === wanted) ? wanted : null);
    } else {
      setNotice(`Couldn't load experiences, so Game Passes and Developer Products are hidden: ${experienceResult.reason?.message ?? experienceResult.reason}`);
    }
    if (!c.access.avatarItems) setNotice("Your role in this group can manage experiences but not avatar items, so only game passes, developer products and badges are shown.");
    setLoadingAvatar(false);
    // Bring back this page visit's sales for the creator (no request), or load them if
    // wanted. Unless that's switched off, they load in the background straight away.
    const background = settingsRef.current.backgroundSales && c.access.earnings;
    if (reloadSales || background || next?.state.entry) loadSales(pageRange, c);
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

  const loaderFor = (c: Creator) => salesLoader(c, client, salesCache, () => settingsRef.current.rememberSales);

  // Follow the loader. While a long load streams in, the report is redone a
  // few times a second rather than on every page.
  useEffect(() => {
    if (!loader) return;
    setLoaded(loader.state);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = loader.subscribe(() => {
      if (!loader.state.loading) {
        clearTimeout(timer);
        timer = undefined;
        setLoaded(loader.state);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          setLoaded(loader.state);
        }, 300);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [loader]);

  /** The loaded sales summarized for the range (and the period before it, for comparison). */
  const summary = useMemo(() => {
    const entry = loaded?.entry;
    if (!entry) return { since: null, current: null, previous: null };
    const { coveredFrom } = entry;
    const transactions = scopedSales;
    const now = new Date();
    if (range === "all") {
      const first = coveredFrom ?? transactions.at(-1)?.created ?? now.toISOString();
      const bucket: Bucket = now.getTime() - new Date(first).getTime() > WEEKLY_AFTER_DAYS * DAY ? "week" : "day";
      return { since: first, current: summarize(transactions, new Date(first), now, items, bucket), previous: null };
    }
    const start = new Date(now.getTime() - (range - 1) * DAY);
    const prevEnd = new Date(start.getTime() - DAY);
    const prevStart = new Date(prevEnd.getTime() - (range - 1) * DAY);
    return { since: start.toISOString(), current: summarize(transactions, start, now, items), previous: summarize(transactions, prevStart, prevEnd, items) };
  }, [loaded?.entry, scopedSales, range, items]);

  const salesLoading = !!loaded?.loading;
  const sales: SalesState = {
    range,
    ...summary,
    loading: salesLoading,
    progress: loaded?.progress ?? null,
    fraction: loaded?.fraction ?? null,
    error: salesBlocked ?? loaded?.error ?? null,
    // Loading stopped before the start of the range.
    truncated: !salesLoading && !!loaded?.entry && !cacheCovers(loaded.entry, salesWantedFor(range)),
    partial: salesLoading && !!loaded?.entry && !cacheCovers(loaded.entry, salesWantedFor(range)),
    complete: !!loaded?.entry && cacheCovers(loaded.entry, null),
    balance: loaded?.balance ?? null,
    loadedAt: loaded?.loadedAt ?? null,
  };

  /**
   * Shows sales for a range, loading whatever isn't loaded yet. Asking again
   * while a load that covers it is running doesn't restart it; `force`
   * (Refresh, Keep loading) fetches anyway. All time only goes all the way
   * back when asked (`force`, or loadAllTime): it can take a long while, so
   * just picking it keeps the recent sales up to date and shows what's loaded.
   */
  const loadSales = (newRange: ReportRange, forCreator: Creator | null = creator, { force = false }: { force?: boolean } = {}) => {
    if (!forCreator) return;
    salesWanted.current = true;
    pageRange = newRange;
    setRange(newRange);
    if (!forCreator.access.earnings) {
      setSalesBlocked("Your role in this group can't view its revenue, so earnings aren't available.");
      return;
    }
    const want = newRange === "all" && !force ? salesWantedFor(30) : salesWantedFor(newRange);
    loaderFor(forCreator).load(want, { force });
  };

  /** Loads the whole sales history (the "Load all-time data" button). */
  const loadAllTime = () => loadSales("all", creator, { force: true });

  /** Stops a long sales load and shows what was loaded so far. */
  const stopSales = () => loader?.stop();


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
    loadAllTime,
    stopSales,
    earningsPerSale,
    ensureSplits,
    settings,
    updateSettings,
    storage,
    /** Every sale loaded for the creator, newest first. */
    salesEntry: loaded?.entry ?? null,
    /** Sales of what's on screen (the store or the selected experience), newest first. */
    scopedSales,
    gameStats,
    /** Makes sure sales back to `since` are loaded (for periods that aren't a report range). */
    loadSalesSince: (since: Date) => creator?.access.earnings && loaderFor(creator).load(since),
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
