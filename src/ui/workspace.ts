import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listCreators } from "../api/account";
import { listAvatarItems } from "../api/catalog";
import { EXPERIENCE_CREATOR_SHARE, getBalance, getCreatorSplitPercent, listSales } from "../api/economy";
import { listDevProducts, listExperiences, listGamePasses } from "../api/experiences";
import { createClient, type RobloxClient } from "../api/http";
import { getThumbnails } from "../api/thumbnails";
import type { Creator, Experience, SellableItem } from "../api/types";
import { summarize, type EarningsSummary, type SaleTransaction } from "../core/earnings";
import type { Edit } from "../core/edits";
import { History, chromeStorage, memoryStorage } from "../core/history";

// Everything the tabs share: who we're working on, their items, unsaved
// edits, sales data and history. Lives in the panel shell.

export const creatorKey = (c: Creator) => `${c.type}:${c.id}`;
const splitKey = (assetType: number, price: number) => `${assetType}:${price}`;

export type RangeDays = 7 | 30 | 90;

export interface SalesState {
  range: RangeDays;
  loading: boolean;
  progress: string | null;
  error: string | null;
  truncated: boolean;
  current: EarningsSummary | null;
  previous: EarningsSummary | null;
  balance: number | null;
  loadedAt: Date | null;
}

function initialCreator(creators: Creator[]): Creator {
  const groupId = Number(new URLSearchParams(location.search).get("groupId"));
  return creators.find((c) => c.type === "Group" && c.id === groupId) ?? creators[0];
}

const makeHistory = () => new History(typeof chrome !== "undefined" && chrome.storage?.local ? chromeStorage() : memoryStorage());

export function useWorkspaceState() {
  const client = useMemo<RobloxClient>(() => createClient(), []);
  const history = useMemo(makeHistory, []);

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
    range: 30, loading: false, progress: null, error: null, truncated: false, current: null, previous: null, balance: null, loadedAt: null,
  });
  const salesAbort = useRef<AbortController | null>(null);
  const transactionsRef = useRef<SaleTransaction[]>([]);
  /** Set once anything asks for sales, so switching creator reloads them. */
  const salesWanted = useRef(false);

  const items = useMemo(() => [...avatarItems, ...experienceItems], [avatarItems, experienceItems]);
  const experience = experiences.find((x) => x.universeId === universeId) ?? null;

  const addThumbnails = (list: SellableItem[]) => {
    getThumbnails(client, list).then((found) => setThumbs((prev) => new Map([...prev, ...found])));
  };

  /** Fetches the creator share for any asset type + price pairs not looked up yet. */
  const ensureSplits = (wanted: { item: SellableItem; price: number | null }[]) => {
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
    listCreators(client)
      .then((list) => {
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
    setLoadingAvatar(true);
    setError(null);
    setNotice(null);
    setAvatarItems([]);
    setExperienceItems([]);
    setExperiences([]);
    setUniverseId(null);
    setEdits(new Map());
    setSplits(new Map());
    splitRequests.current.clear();
    salesAbort.current?.abort();
    transactionsRef.current = [];
    setSales((s) => ({ ...s, current: null, previous: null, balance: null, loadedAt: null, error: null, truncated: false, loading: false, progress: null }));

    const [avatarResult, experienceResult] = await Promise.allSettled([
      c.access.avatarItems ? listAvatarItems(client, c) : Promise.resolve([]),
      c.access.experiences ? listExperiences(client, c) : Promise.resolve([]),
    ]);
    if (avatarResult.status === "fulfilled") {
      setAvatarItems(avatarResult.value);
      addThumbnails(avatarResult.value);
      ensureSplits(avatarResult.value.map((item) => ({ item, price: item.price })));
      history.autoSnapshot(creatorKey(c), avatarResult.value).catch(() => {});
    } else {
      setError(`Couldn't load avatar items: ${avatarResult.reason?.message ?? avatarResult.reason}`);
    }
    if (experienceResult.status === "fulfilled") {
      setExperiences(experienceResult.value);
      setUniverseId(experienceResult.value[0]?.universeId ?? null);
    } else {
      setNotice(`Couldn't load experiences, so Game Passes and Developer Products are hidden: ${experienceResult.reason?.message ?? experienceResult.reason}`);
    }
    if (!c.access.avatarItems) setNotice("Your role in this group can manage experiences but not avatar items, so only game passes, developer products and badges are shown.");
    setLoadingAvatar(false);
    if (reloadSales) loadSales(sales.range, c);
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
    if (loaded.length) history.autoSnapshot(`${creatorKey(creator)}:universe:${id}`, loaded).catch(() => {});
    if (failed.length) setNotice(`Couldn't load some experience items: ${failed[0].reason?.message ?? failed[0].reason}`);
    setLoadingExperience(false);
  };

  useEffect(() => {
    loadExperience(universeId);
  }, [universeId]);

  /** Re-summarizes already-loaded transactions (e.g. after items load, for categories). */
  const resummarize = (range: RangeDays, transactions = transactionsRef.current) => {
    const now = new Date();
    const start = new Date(now.getTime() - (range - 1) * 86400000);
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (range - 1) * 86400000);
    return { current: summarize(transactions, start, now, items), previous: summarize(transactions, prevStart, prevEnd, items) };
  };

  const loadSales = async (range: RangeDays, forCreator: Creator | null = creator) => {
    if (!forCreator) return;
    salesWanted.current = true;
    if (!forCreator.access.earnings) {
      setSales((s) => ({ ...s, range, error: "Your role in this group can't view its revenue, so earnings aren't available." }));
      return;
    }
    salesAbort.current?.abort();
    const controller = new AbortController();
    salesAbort.current = controller;
    setSales((s) => ({ ...s, range, loading: true, error: null, progress: "Loading sales…" }));
    try {
      // Twice the range, so we can compare with the previous period.
      const since = new Date(Date.now() - range * 2 * 86400000);
      const [{ transactions, truncated }, balance] = await Promise.all([
        listSales(client, forCreator, since, {
          signal: controller.signal,
          onProgress: (p) =>
            setSales((s) => ({ ...s, progress: `Loading sales… ${p.sales.toLocaleString()} so far${p.oldest ? `, back to ${new Date(p.oldest).toLocaleDateString()}` : ""}` })),
        }),
        getBalance(client, forCreator),
      ]);
      if (controller.signal.aborted) return;
      transactionsRef.current = transactions;
      setSales((s) => ({ ...s, ...resummarize(range, transactions), balance, truncated, loading: false, progress: null, loadedAt: new Date() }));
    } catch (e) {
      if (controller.signal.aborted) return;
      setSales((s) => ({ ...s, loading: false, progress: null, error: `Couldn't load sales: ${(e as Error).message}` }));
    }
  };

  // Keep categories/names in the report in step with the loaded items.
  useEffect(() => {
    if (sales.loadedAt) setSales((s) => ({ ...s, ...resummarize(s.range) }));
  }, [items]);

  /** What the creator gets from one sale at `price`, or null if unknown. */
  const earningsPerSale = (item: SellableItem, price: number | null): number | null => {
    if (price == null) return null;
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
    thumbs,
    edits,
    setEdits,
    reloadCreator: () => creator && loadCreator(creator),
    reloadExperience: () => loadExperience(universeId),
    sales,
    loadSales,
    earningsPerSale,
    ensureSplits,
  };
}

export type Workspace = ReturnType<typeof useWorkspaceState>;

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside the RoBulk panel");
  return ws;
}
