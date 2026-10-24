import { getBalance, listSales, resetSalesSources, type TransactionResult } from "../api/economy";
import { RobloxApiError, type RobloxClient } from "../api/http";
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
//
// Loads are either main loads (the selected group, anything the RoBulk panel
// asks for) or background loads (the Account Overview's other groups). A
// background load waits between pages whenever a main load is running
// anywhere on the page, so the two never page through Roblox at once.
//
// A load never starts over. Asking for more while it runs widens what it's
// loading; a Refresh waits until it's finished; switching creators lets it
// carry on in the background; and if Roblox fails part-way, it tries again
// from the last page it kept. The only time it pages from the newest sale
// again is when Roblox won't accept the saved place to carry on from.

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
  /** Gives way to main loads; see the top of this file. */
  background: boolean;
}

const covers = (outer: Date | null, inner: Date | null) => outer === null || (inner !== null && outer <= inner);

/** How long to wait before trying again after Roblox fails, times the attempt number (tests shorten it). */
export const loaderTiming = { retryMs: 4000, rateLimitMs: 60_000 };

/** Told about every change to any loader, for things outside the panel like the sidebar. */
const pageListeners = new Set<() => void>();

export class SalesLoader {
  state: LoaderState = { entry: null, balance: null, loadedAt: null, loading: false, progress: null, fraction: null, error: null };
  private listeners = new Set<() => void>();
  private running: Running | null = null;
  /** A Refresh asked for while loading; it runs once the load is finished. */
  private refreshAfter: Date | null | undefined = undefined;
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
   * nothing if they already are. While a load is running it's never
   * restarted: asking for more widens it, and `force` (Refresh, Keep
   * loading) runs once it's finished.
   */
  load(want: Date | null, { force = false, background = false }: { force?: boolean; background?: boolean } = {}) {
    const { entry, loadedAt } = this.state;
    if (this.running) {
      // Asked for as a main load now: stop giving way.
      if (!background && this.running.background) {
        this.running.background = false;
        this.set({});
      }
      if (!covers(this.running.want, want)) this.running.want = want; // go further back as part of the same load
      else if (force) this.refreshAfter = want;
      return;
    }
    if (!force && loadedAt && entry && cacheCovers(entry, want)) return;
    const controller = new AbortController();
    this.running = { want, controller, background };
    void this.run(controller).finally(() => {
      if (this.running?.controller !== controller) return;
      this.running = null;
      // A Refresh asked for part-way through happens now.
      const refresh = this.refreshAfter;
      this.refreshAfter = undefined;
      if (refresh !== undefined && !controller.signal.aborted) this.load(refresh, { force: true });
    });
  }

  /** Keeps a running load going, but behind whatever is loading for the creator now on screen. */
  demote() {
    if (this.running && !this.running.background) {
      this.running.background = true;
      this.set({});
    }
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

  /** Resolves once sales back to `want` (null = everything) are loaded, or nothing is loading any more. */
  whenCovers(want: Date | null): Promise<void> {
    const ready = () => !this.state.loading || (!!this.state.entry && cacheCovers(this.state.entry, want));
    if (ready()) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (!ready()) return;
        unsubscribe();
        resolve();
      });
    });
  }

  /** A main load is running (not one giving way to others). */
  get mainLoading(): boolean {
    return !!this.running && !this.running.background && this.state.loading;
  }

  /** For a background load: waits while a main load runs anywhere on the page. */
  private async waitTurn(controller: AbortController) {
    const busy = () => this.running?.controller === controller && this.running.background && [...loaders.values()].some((l) => l !== this && l.mainLoading);
    if (!busy()) return;
    const progress = this.state.progress;
    const main = [...loaders.values()].find((l) => l !== this && l.mainLoading);
    this.set({ progress: `Waiting for ${main?.creator.name ?? "another group"} to finish loading first…` });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (busy() && !controller.signal.aborted) return;
        off();
        resolve();
      };
      const off = onPageLoadingChange(check);
      controller.signal.addEventListener("abort", check);
    });
    this.set({ progress });
  }

  /** Stops loading and keeps what's loaded. */
  stop() {
    if (!this.running) return;
    this.running.controller.abort();
    this.running = null;
    this.refreshAfter = undefined;
    this.set({ loading: false, progress: null, fraction: null });
  }

  private async run(controller: AbortController) {
    const { signal } = controller;
    const target = () => (this.running?.controller === controller ? this.running.want : null);
    this.set({ loading: true, error: null, progress: "Loading sales…", fraction: 0 });
    let failures = 0;
    let rateLimited = 0;
    while (!signal.aborted) {
      try {
        if (await this.pass(controller, target)) break;
        failures = 0;
      } catch (e) {
        if (signal.aborted) return;
        // Still too many requests after waiting it out: that's Roblox asking for patience, not a failure.
        if (e instanceof RobloxApiError && e.status === 429 && rateLimited++ < 10) {
          this.set({ progress: "Roblox asked RoBulk to slow down for a while. It'll carry on from where it got to in a minute; nothing is lost." });
          await new Promise((r) => setTimeout(r, loaderTiming.rateLimitMs));
          continue;
        }
        // Everything loaded so far is kept, so trying again carries on from the last page.
        if (++failures > 3) {
          this.set({ loading: false, progress: null, fraction: null, error: `Couldn't load sales: ${(e as Error).message}. What's loaded is kept; Refresh carries on from there.` });
          return;
        }
        this.set({ progress: `Roblox didn't answer, so RoBulk is trying again from where it got to (${failures} of 3)…` });
        await new Promise((r) => setTimeout(r, loaderTiming.retryMs * failures));
      }
    }
    if (!signal.aborted) this.set({ loading: false, progress: null, fraction: null });
  }

  /**
   * One pass towards the target: what's new since the last load, then
   * further back from where loading got to. True once there's nothing left
   * to load (or nothing more Roblox will give); false if the target was
   * widened during the pass and there's more to do.
   */
  private async pass(controller: AbortController, target: () => Date | null): Promise<boolean> {
    const { signal } = controller;
    const want = target();
    const fresh = this.state.loadedAt !== null;
    const now = new Date();
    // This visit's sales if any, otherwise what earlier visits saved in the browser.
    let cached = this.state.entry;
    if (!cached && this.remember()) {
      cached = await this.cache.read(this.key);
      if (signal.aborted) return true;
      if (cached) this.set({ entry: cached });
    }

    /** Pages back from `fromCursor` (or the newest sale) to `stopAt`, keeping each page. `already` counts what was loaded before. */
    const fetchSales = (stopAt: Date | null | (() => Date | null), label: string, startsAt: Date, already: number, onPage: (soFar: TransactionResult) => void, fromCursor?: string) => {
      const stopNow = () => (typeof stopAt === "function" ? stopAt() : stopAt);
      return listSales(this.client, this.creator, stopAt, {
        // All time gets far more pages than a fixed date range. A load that can be widened (`stopAt` is a
        // function) might become all time part-way, so it gets as many; a date still stops it on its own.
        maxPages: typeof stopAt === "function" || stopAt === null ? 5000 : 200,
        fromCursor,
        signal,
        onPage,
        beforePage: () => this.waitTurn(controller),
        onRateLimited: (waitMs) =>
          this.set({ progress: `Roblox asked RoBulk to slow down, so it's pausing for ${Math.ceil(waitMs / 1000)} seconds and then carrying on more slowly. Nothing is lost.` }),
        onProgress: (p) => {
          const end = stopNow();
          const span = end ? startsAt.getTime() - end.getTime() : 0;
          this.set({
            // One running total for the whole load, so the count never seems to start again.
            progress:
              label +
              `${(already + p.sales).toLocaleString()} sales loaded` +
              (p.skipping && p.reached
                ? `. Going past sales it already has to reach older ones: at ${new Date(p.reached).toLocaleDateString()}`
                : p.oldest
                  ? `, back to ${new Date(p.oldest).toLocaleDateString()}`
                  : "") +
              (end === null && !fromCursor ? ". Only the first load takes this long." : "."),
            // Paging runs newest to oldest, so how far back it's got is how far along it is.
            fraction: span > 0 ? Math.min(1, p.oldest ? (startsAt.getTime() - new Date(p.oldest).getTime()) / span : 0) : null,
          });
        },
      });
    };

    /**
     * Pages from the newest sale back to `stopAt`, folding them in on top of
     * `base`. With `followTarget`, it goes as far back as the load's target,
     * even if that's widened while it runs.
     */
    const fromNewest = async (base: SalesCacheEntry | null, stopAt: Date | null, label: string, followTarget = false) => {
      const stopNow = () => (followTarget ? target() : stopAt);
      const keepPage = (soFar: TransactionResult) => {
        if (signal.aborted) return;
        // Until paging reaches sales already kept, the new ones don't join up with them yet.
        const oldest = soFar.transactions.at(-1)?.created;
        if (base && (!oldest || new Date(oldest) > new Date(base.updatedAt))) return;
        this.keep(mergeFetched(base, soFar, stopNow(), now), { loadedAt: now });
      };
      const fetched = await fetchSales(followTarget ? stopNow : stopAt, label, now, base?.sales.length ?? 0, keepPage);
      if (signal.aborted) return null;
      const merged = mergeFetched(base, fetched, stopNow(), now);
      this.keep(merged, { loadedAt: now });
      return merged;
    };

    // Going further back than what's loaded carries on from where the last
    // load stopped, instead of paging through those sales again.
    const resume = !!cached?.olderCursor && !cacheCovers(cached, want);
    let merged = cached;
    // Sales fetched on this visit only need the older part; saved ones also need what's new.
    if (!(resume && fresh)) {
      getBalance(this.client, this.creator).then((balance) => this.set({ balance }));
      const stopAt = resume ? planFetch(cached, new Date(cached!.coveredFrom!), now) : planFetch(cached, want, now);
      // Loading back to the target itself (not just what's new): keep going if the target is widened meanwhile.
      const toTarget = !resume && stopAt === want;
      merged = await fromNewest(cached, stopAt, stopAt === null ? "Loading your full sales history… " : "Loading sales… ", toTarget);
      if (!merged) return true;
    }
    if (resume && merged?.olderCursor && !cacheCovers(merged, want)) {
      const base = merged;
      const keepPage = (soFar: TransactionResult) => signal.aborted || this.keep(mergeOlder(base, soFar, target()));
      try {
        const older = await fetchSales(target, "Loading older sales… ", new Date(base.coveredFrom!), base.sales.length, keepPage, base.olderCursor!);
        if (signal.aborted) return true;
        this.keep(mergeOlder(base, older, target()));
      } catch (e) {
        if (signal.aborted) return true;
        // Anything but Roblox refusing the saved place to carry on from, like a
        // dropped connection, is tried again from the last page.
        if (!(e instanceof RobloxApiError && e.status === 400)) throw e;
        const latest = this.state.entry;
        if (latest?.coveredFrom && base.olderCursor?.startsWith("eco:")) {
          // The economy service's cursors are page numbers, so they stop working whenever a new sale
          // comes in. Page back to where loading got to, skipping what's already loaded, and carry on:
          // nothing is fetched twice into the report, it just costs those pages again.
          const keepAgain = (soFar: TransactionResult) => signal.aborted || this.keep(mergeOlder(latest, soFar, target()));
          const resumed = await fetchSales(target, "Catching up to where it got to (a new sale moved Roblox's place marker)… ", new Date(), latest.sales.length, keepAgain, `eco:S${Date.parse(latest.coveredFrom)}|`);
          if (signal.aborted) return true;
          this.keep(mergeOlder(latest, resumed, target()));
        } else if (!(await fromNewest(this.state.entry, want, "Loading your sales history again from the newest sale (Roblox wouldn't let RoBulk carry on from where it stopped)… ", true))) {
          return true;
        }
      }
    }
    const entry = this.state.entry;
    const goal = target();
    // Done when everything asked for is in, or when there's nowhere left to carry on from.
    if (!entry || cacheCovers(entry, goal) || !entry.olderCursor) return true;
    // The target was widened while this pass ran; it hasn't reached it yet.
    return goal !== want ? false : true;
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

/** The sales load running on the page right now, if any (a main load before a background one). */
export function pageLoading(): PageLoading | null {
  const all = [...loaders.values()].filter((l) => l.state.loading);
  const l = all.find((x) => x.mainLoading) ?? all[0];
  return l ? { fraction: l.state.fraction, label: l.state.progress ?? "Loading sales…" } : null;
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
  resetSalesSources();
}
