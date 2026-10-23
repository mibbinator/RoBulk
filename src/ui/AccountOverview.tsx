import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cachedCreators, payoutPercentage } from "../api/account";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { change, summarize, type EarningsSummary } from "../core/earnings";
import { extensionOverflowStore } from "../core/overflowStore";
import { SalesCache, cacheCovers } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings } from "../core/settings";
import { robux } from "./charts";
import { Segmented, downloadText } from "./components";
import { salesLoader, type SalesLoader } from "./salesLoader";
import { creatorKey, initialCreator, makeStorage, rangeLabel, type ReportRange } from "./workspace";

// Every creator the user can see the earnings of, side by side. Nothing is
// loaded until "Run report" is pressed. The group the dashboard has selected
// goes first, as a normal load; the others follow one at a time as background
// loads, which wait whenever the selected group (or anything the RoBulk panel
// asks for) is loading, so they never page through Roblox at the same time.
// Each one's sales are kept for the page visit like the Earnings report's.
//
// The table lists the user's own account and the groups they own first. For
// groups they're only a member of, "Your share" is their recurring payout
// percentage of what the group earned.

const DAY = 86_400_000;

interface Row {
  creator: Creator;
  owned: boolean;
  /** Recurring payout percentage for a group the user doesn't own; null when their role can't see it. */
  percent: number | null;
  /** What the user gets: everything for what they own, their payout percentage of the rest. */
  share: number | null;
  loader: SalesLoader;
  current: EarningsSummary | null;
  previous: EarningsSummary | null;
  /** Loaded back to the start of the range (and the period before it). */
  complete: boolean;
}

const wantFor = (range: ReportRange) => (range === "all" ? null : new Date(Date.now() - range * 2 * DAY));

function summaries(loader: SalesLoader, range: ReportRange) {
  const entry = loader.state.entry;
  if (!entry) return { current: null, previous: null, complete: false };
  const now = new Date();
  const complete = cacheCovers(entry, wantFor(range));
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

type RunState = "idle" | "running" | "done" | "stopped";

export function AccountOverview({ onClose, onOpenCreator }: { onClose: () => void; onOpenCreator: (creator: Creator) => void }) {
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const [loaders, setLoaders] = useState<SalesLoader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ReportRange>(30);
  /** The range the last run loaded; the table shows that until the next run. */
  const [ranFor, setRanFor] = useState<ReportRange | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [current, setCurrent] = useState<string | null>(null);
  /** The group the dashboard has selected; its load is RoBulk's own, not the report's. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Recurring payout percentage for each group the user doesn't own (null: not allowed to see it). */
  const [percents, setPercents] = useState<Map<string, number | null>>(new Map());
  const cancelled = useRef(false);
  /** Bumped when any loader changes, a few times a second at most. */
  const [tick, setTick] = useState(0);
  const running = runState === "running";

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

  // Leaving the page part-way through stops the report; ask first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const stop = () => {
    cancelled.current = true;
    // The selected group's load belongs to RoBulk itself; only stop the background ones.
    for (const l of loaders) if (creatorKey(l.creator) !== selectedKey) l.stop();
    setRunState("stopped");
    setCurrent(null);
  };

  const close = () => {
    if (running && !confirm("The report is still running. Stop it and close?")) return;
    if (running) stop();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const run = async () => {
    cancelled.current = false;
    setError(null);
    setRunState("running");
    setRanFor(range);
    try {
      const settings = await readSettings(storage).catch(() => DEFAULT_SETTINGS);
      const cache = new SalesCache(storage, { maxSales: () => settings.maxStoredSales, overflow: extensionOverflowStore() });
      setCurrent("Finding your groups…");
      const all = await cachedCreators(client, storage);
      const visible = all.filter((c) => c.access.earnings);
      // The group the dashboard has selected first, then the rest in their usual order.
      const selected = initialCreator(all);
      setSelectedKey(creatorKey(selected));
      const ordered = [...visible.filter((c) => creatorKey(c) === creatorKey(selected)), ...visible.filter((c) => creatorKey(c) !== creatorKey(selected))];
      const list = ordered.map((c) => salesLoader(c, client, cache, () => settings.rememberSales));
      setLoaders(list);

      // For groups the user doesn't own: their cut of the group's recurring payouts.
      const me = all.find((c) => c.type === "User");
      setCurrent("Checking your payout share in groups you don't own…");
      const notOwned = visible.filter((c) => c.type === "Group" && !c.owned);
      const found = await Promise.all(notOwned.map(async (c) => [creatorKey(c), me ? await payoutPercentage(client, c.id, me.id) : null] as const));
      setPercents(new Map(found));

      const want = wantFor(range);
      for (const loader of list) {
        if (cancelled.current) return;
        setCurrent(loader.creator.name);
        // Already loaded far enough back on this visit: nothing to ask Roblox for.
        loader.load(want, { background: creatorKey(loader.creator) !== creatorKey(selected) });
        await loader.whenDone();
      }
      if (!cancelled.current) setRunState("done");
    } catch (e) {
      setError(`Couldn't run the report: ${(e as Error).message}`);
      setRunState("stopped");
    }
    setCurrent(null);
  };

  const shown = ranFor ?? range;
  const rows: Row[] = useMemo(() => {
    const list = loaders.map((loader): Row => {
      const owned = loader.creator.type === "User" || loader.creator.owned === true;
      const sums = summaries(loader, shown);
      const percent = owned ? 100 : (percents.get(creatorKey(loader.creator)) ?? null);
      const earned = sums.current?.totalRobux ?? 0;
      return { creator: loader.creator, loader, owned, percent, share: percent == null ? null : Math.floor((earned * percent) / 100), ...sums };
    });
    // Your account, then the groups you own, then the rest.
    const rank = (r: Row) => (r.creator.type === "User" ? 0 : r.owned ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b));
  }, [loaders, shown, tick, percents]);
  const totalShare = rows.reduce((sum, r) => sum + (r.share ?? 0), 0);
  const unknownShares = rows.filter((r) => r.share == null).length;
  const total = rows.reduce((sum, r) => sum + (r.current?.totalRobux ?? 0), 0);
  const totalPrev = rows.reduce((sum, r) => sum + (r.previous?.totalRobux ?? 0), 0);
  const totalSales = rows.reduce((sum, r) => sum + (r.current?.sales ?? 0), 0);
  const totalPending = rows.reduce((sum, r) => sum + (r.current?.pendingRobux ?? 0), 0);
  const totalBalance = rows.reduce((sum, r) => sum + (r.loader.state.balance ?? 0), 0);
  const largest = Math.max(1, ...rows.map((r) => r.current?.totalRobux ?? 0));
  const doneCount = rows.filter((r) => r.complete && !r.loader.state.loading).length;

  const exportCsv = () => {
    const lines = [["creator", "owned", "earned", "your share %", "your share", "sales", "pending", "balance"].join(",")];
    for (const r of rows) {
      lines.push(
        [csvCell(r.creator.name), r.owned ? "yes" : "no", r.current?.totalRobux ?? 0, r.percent ?? "", r.share ?? "", r.current?.sales ?? 0, r.current?.pendingRobux ?? 0, r.loader.state.balance ?? ""]
          .map(String)
          .join(","),
      );
    }
    downloadText(`account-overview-${shown === "all" ? "all-time" : `${shown}d`}.csv`, lines.join("\r\n") + "\r\n", "text/csv");
  };

  return (
    <div class="rb-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="rb-panel" role="dialog" aria-label="Account overview">
        <header class="rb-header">
          <div class="rb-title">
            <span class="rb-brand">Account Overview</span>
          </div>
          <div class="rb-header-controls">
            <button class="rb-icon-btn" title="Close (Esc)" onClick={close}>
              ✕
            </button>
          </div>
        </header>

        <div class="rb-toolbar">
          <Segmented<string>
            label="Date range"
            value={String(range)}
            onChange={(v) => !running && setRange(v === "all" ? "all" : (Number(v) as ReportRange))}
            options={[
              ["7", "Last 7 days"],
              ["30", "Last 30 days"],
              ["90", "Last 90 days"],
              ["all", "All time"],
            ]}
          />
          <div class="rb-spacer" />
          {running ? (
            <button class="rb-btn rb-btn-ghost" onClick={stop}>
              Stop
            </button>
          ) : (
            <>
              <button class="rb-btn rb-btn-ghost" disabled={rows.length === 0} onClick={exportCsv}>
                Export (.csv)
              </button>
              <button class="rb-btn rb-btn-primary" onClick={run}>
                {runState === "idle" ? "Run report" : ranFor === range ? "Run again" : "Run report"}
              </button>
            </>
          )}
        </div>

        <main class="rb-body rb-report">
          {error && <div class="rb-empty rb-error">{error}</div>}

          {runState === "idle" && !error && (
            <div class="rb-overview-intro">
              <h3>Earnings for your account and all your groups, side by side</h3>
              <p>
                Pick a period and press <strong>Run report</strong>. RoBulk loads your selected group first, then the rest one at a time, so it can take a few minutes if
                you have lots of groups or a long period. Anything already loaded on this visit is reused straight away.
              </p>
            </div>
          )}

          {running && (
            <div class="rb-banner rb-banner-inline rb-overview-running" role="status">
              <span class="rb-spinner" />
              <span>
                <strong>Keep this tab open and stay on the Creator Dashboard until the report finishes.</strong> Closing the tab or going to another site stops it. What's
                loaded is kept, so running it again carries on.
                {current && loaders.length > 0 && (
                  <>
                    {" "}
                    Now loading {current} ({Math.min(doneCount + 1, loaders.length)} of {loaders.length}).
                  </>
                )}
              </span>
            </div>
          )}
          {runState === "stopped" && !error && <div class="rb-banner rb-banner-inline">Stopped. Press Run report to carry on from where it got to.</div>}
          {!running && ranFor !== null && ranFor !== range && (
            <div class="rb-banner rb-banner-inline">
              Showing the {rangeLabel(ranFor)}. Press <strong>Run report</strong> to load the {rangeLabel(range)}.
            </div>
          )}
          {runState !== "idle" && loaders.length === 0 && !running && !error && <div class="rb-empty">None of your groups let your role see their revenue.</div>}

          {rows.length > 0 && (
            <>
              <div class="rb-kpis">
                <div class="rb-stat">
                  <span class="rb-stat-label">Earned, {rangeLabel(shown)}</span>
                  <strong class="rb-stat-value">{robux(total)}</strong>
                  {shown !== "all" && totalPrev > 0 && (
                    <span class={`rb-stat-delta ${total >= totalPrev ? "up" : "down"}`}>
                      {total >= totalPrev ? "▲" : "▼"} {Math.abs(Math.round((change(total, totalPrev) ?? 0) * 100))}% vs previous period
                    </span>
                  )}
                  <span class="rb-stat-hint">
                    Across {rows.length} {rows.length === 1 ? "account" : "accounts and groups"}
                  </span>
                </div>
                <div class="rb-stat">
                  <span class="rb-stat-label">Your share</span>
                  <strong class="rb-stat-value">{robux(totalShare)}</strong>
                  <span class="rb-stat-hint">
                    Everything from what you own, plus your payout share of other groups
                    {unknownShares > 0 ? ` (${unknownShares} ${unknownShares === 1 ? "group hides" : "groups hide"} their payouts from your role)` : ""}
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
                        <th>Earned, {rangeLabel(shown)}</th>
                        <th class="num">Change</th>
                        <th class="num">Your share</th>
                        <th class="num">Sales</th>
                        <th class="num">Pending</th>
                        <th class="num">Balance</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const earned = r.current?.totalRobux ?? 0;
                        // A heading where the groups you don't own start.
                        const heading =
                          i === 0 || (rows[i - 1].owned && !r.owned) ? (
                            <tr class="rb-row-heading" key={`h-${r.owned}`}>
                              <th colSpan={8}>{r.owned ? "Your account and groups you own" : "Groups you don't own: your share is your recurring payout percentage"}</th>
                            </tr>
                          ) : null;
                        const delta = r.previous && r.complete ? change(earned, r.previous.totalRobux) : undefined;
                        const { loading, progress } = r.loader.state;
                        return [
                          heading,
                          <tr key={creatorKey(r.creator)}>
                            <td>
                              <strong>{r.creator.type === "User" ? `${r.creator.name} (you)` : r.creator.name}</strong>
                              {creatorKey(r.creator) === selectedKey && <span class="rb-chip rb-chip-quiet">Selected</span>}
                              {loading && <div class="rb-small rb-muted">{progress ?? "Loading…"}</div>}
                              {!loading && !r.complete && r.current && <div class="rb-small rb-muted">Not loaded all the way back yet</div>}
                              {!loading && !r.current && <div class="rb-small rb-muted">{running ? "Waiting its turn…" : "Not loaded"}</div>}
                            </td>
                            <td>
                              <div class="rb-overview-bar-cell">
                                <div class="rb-overview-bar" title={robux(earned)}>
                                  <div style={{ width: `${(earned / largest) * 100}%` }} />
                                </div>
                                <span class="rb-overview-value">{r.current ? robux(earned) : "—"}</span>
                              </div>
                            </td>
                            <td class="num">
                              {delta === undefined ? "—" : delta == null ? "New" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}%`}
                            </td>
                            <td class="num">
                              {r.owned ? (
                                r.current ? robux(earned) : "—"
                              ) : r.percent == null ? (
                                <span class="rb-muted" title="Your role in this group can't see its payout percentages">Hidden</span>
                              ) : (
                                <span title={`${r.percent}% recurring payout`}>
                                  {r.current ? robux(r.share ?? 0) : "—"} <span class="rb-muted rb-small">({r.percent}%)</span>
                                </span>
                              )}
                            </td>
                            <td class="num">{r.current ? r.current.sales.toLocaleString() : "—"}</td>
                            <td class="num">{r.current ? robux(r.current.pendingRobux) : "—"}</td>
                            <td class="num">{r.loader.state.balance == null ? "—" : robux(r.loader.state.balance)}</td>
                            <td class="num">
                              <button class="rb-link-btn" disabled={running} onClick={() => onOpenCreator(r.creator)}>
                                Open report
                              </button>
                            </td>
                          </tr>,
                        ];
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
