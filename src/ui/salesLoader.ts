import { getBalance, listSales, type TransactionResult } from "../api/economy";
import type { RobloxClient } from "../api/http";
import type { Creator } from "../api/types";
import { SalesCache, cacheCovers, mergeFetched, mergeOlder, planFetch, type SalesCacheEntry } from "../core/salesCache";

// Loads one creator's sales and keeps them for the rest of the page visit.
//
// A loader belongs to the page, not to the RoBulk panel: closing the panel
// doesn't stop a long "All time" load, and reopening it shows how far it has
// got. Asking for a range that the running load will already cover leaves it
// alone instead of starting over. Every page of sales is kept as soon as it
// arrives and saved to the browser right behind it, so stopping, closing the
// tab or switching away loses at most the page that was on its way.

export interface LoaderState {
  /** Everything loaded so far, newest first. */
  entry: SalesCacheEntry | null;
  balance: number | null;
  /** When the newest sales were last fetched on this visit; null until then. */
  loadedAt: Date | null;
  loading: boolean;
  progress: string | null;
  /** How far the load has got, 0 to 1, or null when there's no way to know. */
  fraction: number | null;
  error: string | null;
}

interface Running {
  /** How far back it's going; null = everything. */
  want: Date | null;
  controller: AbortController;
}

const covers = (outer: Date | null, inner: Date | null) => outer === null || (inner !== null && outer <= inner);

/** Told about every change to any loader, for things outside the panel like the sidebar. */
const pageListeners = new Set<() => void>();

export class SalesLoader {
  state: LoaderState = { entry: null, balance: null, loadedAt: null, loading: false, progress: null, fraction: null, error: null };
  private listeners = new Set<() => void>();
  private running: Running | null = null;
  /** Browser saves run one at a time, always writing the latest sales. */
  private unsaved: SalesCacheEntry | null = null;
  private saving = false;

  constructor(
    readonly creator: Creator,
    private client: RobloxClient,
    private cache: SalesCache,
    /** Read on every save, so switching "Remember sales" off takes effect straight away. */
    private remember: () => boolean,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<LoaderState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    for (const l of pageListeners) l();
  }

  /** Keeps newly loaded sales and saves them to the browser as soon as it's free. */
  private keep(entry: SalesCacheEntry, patch: Partial<LoaderState> = {}) {
    this.set({ entry, ...patch });
    if (!this.remember()) return;
    this.unsaved = entry;
    if (this.saving) return;
    this.saving = true;
    void (async () => {
      while (this.unsaved && this.remember()) {
        const next = this.unsaved;
        this.unsaved = null;
        await this.cache.write(this.key, next);
      }
      this.unsaved = null;
      this.saving = false;
    })();
  }

  private get key() {
    return `${this.creator.type}:${this.creator.id}`;
  }

  /** Waits until everything kept so far is saved (for tests). */
  async flushed(): Promise<void> {
    while (this.saving) await new Promise((r) => setTimeout(r, 5));
  }

  /**
   * Makes sure sales back to `want` (null = everything) are loaded. Does
   * nothing if they already are, or if the load that's running will get
   * there; `force` (Refresh, Keep loading) fetches anyway.
   */
  load(want: Date | null, { force = false }: { force?: boolean } = {}) {
    const { entry, loadedAt } = this.state;
    if (!force && this.running && covers(this.running.want, want)) return;
    if (!force && !this.running && loadedAt && entry && cacheCovers(entry, want)) return;
    this.running?.controller.abort();
    const controller = new AbortController();
    this.running = { want, controller };
    void this.run(want, controller).finally(() => {
      if (this.running?.controller === controller) this.running = null;
    });
  }

  /** Resolves once nothing is loading (straight away if nothing is). */
  whenDone(): Promise<void> {
    if (!this.state.loading) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (this.state.loading) return;
        unsubscribe();
        resolve();
      });
    });
  }

  /** Stops loading and keeps what's loaded. */
  stop() {
    if (!this.running) return;
    this.running.controller.abort();
    this.running = null;
    this.set({ loading: false, progress: null, fraction: null });
  }

  private async run(want: Date | null, controller: AbortController) {
    const { signal } = controller;
    const fresh = this.state.loadedAt !== null;
    this.set({ loading: true, error: null, progress: "Loading sales…", fraction: 0 });
    try {
      const now = new Date();
      // This visit's sales if any, otherwise what earlier visits saved in the browser.
      let cached = this.state.entry;
      if (!cached && this.remember()) {
        cached = await this.cache.read(this.key);
        if (signal.aborted) return;
        if (cached) this.set({ entry: cached });
      }

      /** Pages back from `fromCursor` (or the newest sale) to `stopAt`, keeping each page. */
      const fetchSales = (stopAt: Date | null, label: string, startsAt: Date, onPage: (soFar: TransactionResult) => void, fromCursor?: string) => {
        const span = stopAt ? startsAt.getTime() - stopAt.getTime() : 0;
        return listSales(this.client, this.creator, stopAt, {
          maxPages: stopAt === null ? 5000 : 200,
          fromCursor,
          signal,
          onPage,
          onProgress: (p) =>
            this.set({
              progress:
                label +
                `${p.sales.toLocaleString()} so far` +
                (p.oldest ? `, back to ${new Date(p.oldest).toLocaleDateString()}` : "") +
                (stopAt === null ? ". Only the first load takes this long." : ""),
              // Paging runs newest to oldest, so how far back it's got is how far along it is.
              fraction: span > 0 ? Math.min(1, p.oldest ? (startsAt.getTime() - new Date(p.oldest).getTime()) / span : 0) : null,
            }),
        });
      };

      /** Pages from the newest sale back to `stopAt`, folding them in on top of `base`. */
      const fromNewest = async (base: SalesCacheEntry | null, stopAt: Date | null, label: string) => {
        const keepPage = (soFar: TransactionResult) => {
          if (signal.aborted) return; // a newer load has taken over
          // Until paging reaches sales already kept, the new ones don't join up with them yet.
          const oldest = soFar.transactions.at(-1)?.created;
          if (base && (!oldest || new Date(oldest) > new Date(base.updatedAt))) return;
          this.keep(mergeFetched(base, soFar, stopAt, now), { loadedAt: now });
        };
        const fetched = await fetchSales(stopAt, label, now, keepPage);
        if (signal.aborted) return null;
        const merged = mergeFetched(base, fetched, stopAt, now);
        this.keep(merged, { loadedAt: now });
        return merged;
      };

      // Going further back than what's loaded carries on from where the last
      // load stopped, instead of paging through those sales again.
      const resume = !!cached?.olderCursor && !cacheCovers(cached, want);
      if (!(resume && fresh)) getBalance(this.client, this.creator).then((balance) => this.set({ balance }));
      let merged = cached;
      // Sales fetched on this visit only need the older part; saved ones also need what's new.
      if (!(resume && fresh)) {
        const stopAt = resume ? planFetch(cached, new Date(cached!.coveredFrom!), now) : planFetch(cached, want, now);
        merged = await fromNewest(cached, stopAt, stopAt === null ? "Loading your full sales history… " : "Loading sales… ");
        if (!merged) return;
      }
      if (resume && merged?.olderCursor && !cacheCovers(merged, want)) {
        const base = merged;
        const keepPage = (soFar: TransactionResult) => signal.aborted || this.keep(mergeOlder(base, soFar, want));
        try {
          const older = await fetchSales(want, "Loading older sales… ", new Date(base.coveredFrom!), keepPage, base.olderCursor!);
          if (signal.aborted) return;
          this.keep(mergeOlder(base, older, want));
        } catch {
          if (signal.aborted) return;
          // Roblox may not take a cursor from an earlier visit: page from the newest sale instead.
          if (!(await fromNewest(this.state.entry, want, want === null ? "Loading your full sales history… " : "Loading sales… "))) return;
        }
      }
      if (!signal.aborted) this.set({ loading: false, progress: null, fraction: null });
    } catch (e) {
      if (signal.aborted) return;
      this.set({ loading: false, progress: null, fraction: null, error: `Couldn't load sales: ${(e as Error).message}` });
    }
  }
}

const loaders = new Map<string, SalesLoader>();

/** The page's loader for a creator, created on first use. */
export function salesLoader(creator: Creator, client: RobloxClient, cache: SalesCache, remember: () => boolean): SalesLoader {
  const key = `${creator.type}:${creator.id}`;
  let loader = loaders.get(key);
  if (!loader) loaders.set(key, (loader = new SalesLoader(creator, client, cache, remember)));
  return loader;
}

export interface PageLoading {
  /** 0 to 1, or null when there's no way to know. */
  fraction: number | null;
  label: string;
}

/** The sales load running on the page right now, if any. */
export function pageLoading(): PageLoading | null {
  for (const l of loaders.values()) {
    if (l.state.loading) return { fraction: l.state.fraction, label: l.state.progress ?? "Loading sales…" };
  }
  return null;
}

/** Calls `listener` whenever any loader on the page changes. */
export function onPageLoadingChange(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
}

/** Stops every load and forgets this page visit's sales (for tests). */
export function forgetSalesLoaders() {
  for (const l of loaders.values()) l.stop();
  loaders.clear();
}
