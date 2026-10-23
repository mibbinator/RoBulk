import { useEffect, useMemo, useState } from "preact/hooks";
import { cachedCreators } from "../api/account";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { change, summarize, type EarningsSummary } from "../core/earnings";
import { extensionOverflowStore } from "../core/overflowStore";
import { SalesCache, cacheCovers } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings } from "../core/settings";
import { robux } from "./charts";
import { Segmented, downloadText } from "./components";
import { salesLoader, type SalesLoader } from "./salesLoader";
import { creatorKey, makeStorage, rangeLabel, type ReportRange } from "./workspace";

// Every creator the user can see the earnings of, side by side. Each one's
// sales come from the same loader the Earnings report uses, loaded one
// creator at a time so Roblox isn't asked for everything at once, and kept
// for the page visit like the report's.

const DAY = 86_400_000;

interface Row {
  creator: Creator;
  loader: SalesLoader;
  current: EarningsSummary | null;
  previous: EarningsSummary | null;
  /** Loaded back to the start of the range (and the period before it). */
  complete: boolean;
}

function summaries(loader: SalesLoader, range: ReportRange) {
  const entry = loader.state.entry;
  if (!entry) return { current: null, previous: null, complete: false };
  const now = new Date();
  const want = range === "all" ? null : new Date(now.getTime() - range * 2 * DAY);
  const complete = cacheCovers(entry, want);
  if (range === "all") {
    const first = entry.coveredFrom ?? entry.sales.at(-1)?.created ?? now.toISOString();
    return { current: summarize(entry.sales, new Date(first), now), previous: null, complete };
  }
  const start = new Date(now.getTime() - (range - 1) * DAY);
  const prevEnd = new Date(start.getTime() - DAY);
  const prevStart = new Date(prevEnd.getTime() - (range - 1) * DAY);
  return { current: summarize(entry.sales, start, now), previous: summarize(entry.sales, prevStart, prevEnd), complete };
}

const csvCell = (v: string | number) => (typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`);

export function AccountOverview({ onClose, onOpenCreator }: { onClose: () => void; onOpenCreator: (creator: Creator) => void }) {
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const [creators, setCreators] = useState<Creator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ReportRange>(30);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const remember = settings.rememberSales;
  const cache = useMemo(() => new SalesCache(storage, { maxSales: () => settings.maxStoredSales, overflow: extensionOverflowStore() }), [storage, settings]);
  /** Bumped when any loader changes, a few times a second at most. */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    readSettings(storage).then(setSettings);
    cachedCreators(client, storage)
      .then((list) => setCreators(list.filter((c) => c.access.earnings)))
      .catch((e) => setError(`Couldn't load your groups: ${(e as Error).message}`));
  }, []);

  const loaders = useMemo(() => (creators ?? []).map((c) => salesLoader(c, client, cache, () => remember)), [creators]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        setTick((t) => t + 1);
      }, 250);
    };
    const offs = loaders.map((l) => l.subscribe(bump));
    return () => {
      offs.forEach((off) => off());
      clearTimeout(timer);
    };
  }, [loaders]);

  // One creator at a time; anything already loaded far enough back is reused without asking Roblox.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const loader of loaders) {
        if (cancelled) return;
        loader.load(range === "all" ? null : new Date(Date.now() - range * 2 * DAY));
        await loader.whenDone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaders, range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows: Row[] = useMemo(() => loaders.map((loader) => ({ creator: loader.creator, loader, ...summaries(loader, range) })), [loaders, range, tick]);
  const total = rows.reduce((sum, r) => sum + (r.current?.totalRobux ?? 0), 0);
  const totalPrev = rows.reduce((sum, r) => sum + (r.previous?.totalRobux ?? 0), 0);
  const totalSales = rows.reduce((sum, r) => sum + (r.current?.sales ?? 0), 0);
  const totalPending = rows.reduce((sum, r) => sum + (r.current?.pendingRobux ?? 0), 0);
  const totalBalance = rows.reduce((sum, r) => sum + (r.loader.state.balance ?? 0), 0);
  const largest = Math.max(1, ...rows.map((r) => r.current?.totalRobux ?? 0));
  const loadingAny = rows.some((r) => r.loader.state.loading || !r.complete);

  const exportCsv = () => {
    const lines = [["creator", "earned", "sales", "pending", "balance"].join(",")];
    for (const r of rows) {
      lines.push([csvCell(r.creator.name), r.current?.totalRobux ?? 0, r.current?.sales ?? 0, r.current?.pendingRobux ?? 0, r.loader.state.balance ?? ""].map(String).join(","));
    }
    downloadText(`account-overview-${range === "all" ? "all-time" : `${range}d`}.csv`, lines.join("\r\n") + "\r\n", "text/csv");
  };

  return (
    <div class="rb-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="rb-panel" role="dialog" aria-label="Account overview">
        <header class="rb-header">
          <div class="rb-title">
            <span class="rb-brand">Account Overview</span>
          </div>
          <div class="rb-header-controls">
            <button class="rb-icon-btn" title="Close (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div class="rb-toolbar">
          <Segmented<string>
            label="Date range"
            value={String(range)}
            onChange={(v) => setRange(v === "all" ? "all" : (Number(v) as ReportRange))}
            options={[
              ["7", "Last 7 days"],
              ["30", "Last 30 days"],
              ["90", "Last 90 days"],
              ["all", "All time"],
            ]}
          />
          <div class="rb-spacer" />
          {loadingAny && creators && creators.length > 0 && (
            <span class="rb-muted rb-small rb-updating">
              <span class="rb-spinner" /> Loading one at a time…
            </span>
          )}
          <button class="rb-btn rb-btn-ghost" disabled={rows.length === 0} onClick={exportCsv}>
            Export (.csv)
          </button>
        </div>

        <main class="rb-body rb-report">
          {error && <div class="rb-empty rb-error">{error}</div>}
          {!error && !creators && <div class="rb-empty">Loading your groups…</div>}
          {creators && creators.length === 0 && <div class="rb-empty">None of your groups let your role see their revenue.</div>}

          {rows.length > 0 && (
            <>
              <div class="rb-kpis">
                <div class="rb-stat">
                  <span class="rb-stat-label">Earned, {rangeLabel(range)}</span>
                  <strong class="rb-stat-value">{robux(total)}</strong>
                  {range !== "all" && totalPrev > 0 && (
                    <span class={`rb-stat-delta ${total >= totalPrev ? "up" : "down"}`}>
                      {total >= totalPrev ? "▲" : "▼"} {Math.abs(Math.round((change(total, totalPrev) ?? 0) * 100))}% vs previous period
                    </span>
                  )}
                  <span class="rb-stat-hint">
                    Across {rows.length} {rows.length === 1 ? "account" : "accounts and groups"}
                  </span>
                </div>
                <div class="rb-stat">
                  <span class="rb-stat-label">Sales</span>
                  <strong class="rb-stat-value">{totalSales.toLocaleString()}</strong>
                </div>
                <div class="rb-stat">
                  <span class="rb-stat-label">Pending</span>
                  <strong class="rb-stat-value">{robux(totalPending)}</strong>
                </div>
                <div class="rb-stat">
                  <span class="rb-stat-label">Total balance</span>
                  <strong class="rb-stat-value">{robux(totalBalance)}</strong>
                </div>
              </div>

              <section class="rb-card rb-overview">
                <header class="rb-card-header">
                  <h3>By account and group</h3>
                </header>
                <div class="rb-table-wrap">
                  <table class="rb-table">
                    <thead>
                      <tr>
                        <th>Account or group</th>
                        <th>Earned, {rangeLabel(range)}</th>
                        <th class="num">Change</th>
                        <th class="num">Sales</th>
                        <th class="num">Pending</th>
                        <th class="num">Balance</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const earned = r.current?.totalRobux ?? 0;
                        const delta = r.previous && r.complete ? change(earned, r.previous.totalRobux) : undefined;
                        const { loading, progress } = r.loader.state;
                        return (
                          <tr key={creatorKey(r.creator)}>
                            <td>
                              <strong>{r.creator.type === "User" ? `${r.creator.name} (you)` : r.creator.name}</strong>
                              {loading && <div class="rb-small rb-muted">{progress ?? "Loading…"}</div>}
                              {!loading && !r.complete && r.current && <div class="rb-small rb-muted">Not loaded all the way back yet</div>}
                              {!loading && !r.current && <div class="rb-small rb-muted">Waiting…</div>}
                            </td>
                            <td class="rb-overview-bar-cell">
                              <div class="rb-overview-bar" title={robux(earned)}>
                                <div style={{ width: `${(earned / largest) * 100}%` }} />
                              </div>
                              <span class="rb-overview-value">{r.current ? robux(earned) : "—"}</span>
                            </td>
                            <td class="num">
                              {delta === undefined ? "—" : delta == null ? "New" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}%`}
                            </td>
                            <td class="num">{r.current ? r.current.sales.toLocaleString() : "—"}</td>
                            <td class="num">{r.current ? robux(r.current.pendingRobux) : "—"}</td>
                            <td class="num">{r.loader.state.balance == null ? "—" : robux(r.loader.state.balance)}</td>
                            <td class="num">
                              <button class="rb-link-btn" onClick={() => onOpenCreator(r.creator)}>
                                Open report
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
