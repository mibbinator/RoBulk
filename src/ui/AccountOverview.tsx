import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cachedCreators, payoutPercentage } from "../api/account";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { change, summarize, type EarningsSummary } from "../core/earnings";
import { extensionOverflowStore } from "../core/overflowStore";
import { SalesCache, cacheCovers } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings } from "../core/settings";
import { robux } from "./charts";
import { downloadText } from "./components";
import { salesLoader, type SalesLoader } from "./salesLoader";
import { creatorKey, initialCreator, makeStorage } from "./workspace";

// Every creator the user can see the earnings of, side by side. Nothing is
// loaded until a report is run. "Run report" loads enough for the last 7, 30
// and 90 days at once (and the periods before them, for the change); the
// all-time report is run separately and carries on from where that stopped.
//
// The group the dashboard has selected goes first, as a normal load; the
// others follow one at a time as background loads, which wait whenever the
// selected group (or anything the RoBulk panel asks for) is loading, so they
// never page through Roblox at the same time. Each one's sales are kept for
// the page visit like the Earnings report's.
//
// The table lists the user's own account and the groups they own first. For
// groups they're only a member of, "Your share" is their recurring payout
// percentage of what the group earned.

const DAY = 86_400_000;
const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
/** What "Run report" loads: the longest period and the one before it. */
const recentWant = () => new Date(Date.now() - 90 * 2 * DAY);

interface PeriodSums {
  current: EarningsSummary;
  previous: EarningsSummary;
}

interface Row {
  creator: Creator;
  owned: boolean;
  /** Recurring payout percentage for a group the user doesn't own; null when their role can't see it. */
  percent: number | null;
  loader: SalesLoader;
  periods: Partial<Record<Period, PeriodSums>>;
  all: EarningsSummary | null;
  /** Loaded far enough back for the recent periods / for all time. */
  recentDone: boolean;
  allDone: boolean;
}

function summaries(loader: SalesLoader): Pick<Row, "periods" | "all" | "recentDone" | "allDone"> {
  const entry = loader.state.entry;
  if (!entry) return { periods: {}, all: null, recentDone: false, allDone: false };
  const now = new Date();
  const periods: Row["periods"] = {};
  for (const days of PERIODS) {
    const start = new Date(now.getTime() - (days - 1) * DAY);
    const prevEnd = new Date(start.getTime() - DAY);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY);
    periods[days] = { current: summarize(entry.sales, start, now), previous: summarize(entry.sales, prevStart, prevEnd) };
  }
  const allDone = cacheCovers(entry, null);
  const first = entry.coveredFrom ?? entry.sales.at(-1)?.created ?? now.toISOString();
  return { periods, all: allDone ? summarize(entry.sales, new Date(first), now) : null, recentDone: cacheCovers(entry, recentWant()), allDone };
}

const csvCell = (v: string | number) => (typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`);
const share = (r: Row, robuxEarned: number) => (r.percent == null ? null : Math.floor((robuxEarned * r.percent) / 100));
const changeLabel = (cur: number, prev: number) => {
  const d = change(cur, prev);
  return d == null ? "New" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 100))}%`;
};

type Job = "recent" | "all";

export function AccountOverview({ onClose, onOpenCreator }: { onClose: () => void; onOpenCreator: (creator: Creator) => void }) {
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const [loaders, setLoaders] = useState<SalesLoader[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The report running now, if any. */
  const [job, setJob] = useState<Job | null>(null);
  /** The reports run so far on this visit. */
  const [ran, setRan] = useState<Set<Job>>(new Set());
  const [stopped, setStopped] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  /** The group the dashboard has selected; its load is RoBulk's own, not the report's. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Recurring payout percentage for each group the user doesn't own (null: not allowed to see it). */
  const [percents, setPercents] = useState<Map<string, number | null>>(new Map());
  const cancelled = useRef(false);
  /** Bumped when any loader changes, a few times a second at most. */
  const [tick, setTick] = useState(0);
  const running = job !== null;

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
    setJob(null);
    setStopped(true);
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

  /** The creators and their loaders, found once per visit to the overview. */
  const setUp = async (): Promise<{ list: SalesLoader[]; selected: string }> => {
    if (loaders.length && selectedKey) return { list: loaders, selected: selectedKey };
    const settings = await readSettings(storage).catch(() => DEFAULT_SETTINGS);
    const cache = new SalesCache(storage, { maxSales: () => settings.maxStoredSales, overflow: extensionOverflowStore() });
    setCurrent("Finding your groups…");
    const all = await cachedCreators(client, storage);
    const visible = all.filter((c) => c.access.earnings);
    // The group the dashboard has selected first, then the rest in their usual order.
    const selected = creatorKey(initialCreator(all));
    setSelectedKey(selected);
    const ordered = [...visible.filter((c) => creatorKey(c) === selected), ...visible.filter((c) => creatorKey(c) !== selected)];
    const list = ordered.map((c) => salesLoader(c, client, cache, () => settings.rememberSales));
    setLoaders(list);

    // For groups the user doesn't own: their cut of the group's recurring payouts.
    const me = all.find((c) => c.type === "User");
    setCurrent("Checking your payout share in groups you don't own…");
    const notOwned = visible.filter((c) => c.type === "Group" && !c.owned);
    const found = await Promise.all(notOwned.map(async (c) => [creatorKey(c), me ? await payoutPercentage(client, c.id, me.id) : null] as const));
    setPercents(new Map(found));
    return { list, selected };
  };

  const run = async (which: Job) => {
    cancelled.current = false;
    setError(null);
    setStopped(false);
    setJob(which);
    try {
      const { list, selected } = await setUp();
      // All time carries on from wherever the recent report (or anything else) got to.
      const want = which === "all" ? null : recentWant();
      for (const loader of list) {
        if (cancelled.current) return;
        setCurrent(loader.creator.name);
        loader.load(want, { background: creatorKey(loader.creator) !== selected });
        await loader.whenDone();
      }
      if (!cancelled.current) setRan((prev) => new Set([...prev, which]));
    } catch (e) {
      setError(`Couldn't run the report: ${(e as Error).message}`);
      setStopped(true);
    }
    if (!cancelled.current) setJob(null);
    setCurrent(null);
  };

  const rows: Row[] = useMemo(() => {
    const list = loaders.map((loader): Row => {
      const owned = loader.creator.type === "User" || loader.creator.owned === true;
      const percent = owned ? 100 : (percents.get(creatorKey(loader.creator)) ?? null);
      return { creator: loader.creator, loader, owned, percent, ...summaries(loader) };
    });
    // Your account, then the groups you own, then the rest.
    const rank = (r: Row) => (r.creator.type === "User" ? 0 : r.owned ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b));
    // Also redone when a report finishes, so the last group's numbers show straight away.
  }, [loaders, tick, percents, job, ran]);

  const showAll = ran.has("all") || job === "all" || rows.some((r) => r.allDone && r.all);
  const sum = (pick: (r: Row) => number | null | undefined) => rows.reduce((total, r) => total + (pick(r) ?? 0), 0);
  const totals = Object.fromEntries(PERIODS.map((d) => [d, { cur: sum((r) => r.periods[d]?.current.totalRobux), prev: sum((r) => r.periods[d]?.previous.totalRobux) }])) as Record<
    Period,
    { cur: number; prev: number }
  >;
  const totalShare90 = sum((r) => share(r, r.periods[90]?.current.totalRobux ?? 0));
  const totalAll = sum((r) => r.all?.totalRobux);
  const totalShareAll = sum((r) => (r.all ? share(r, r.all.totalRobux) : 0));
  const totalPending = sum((r) => r.periods[90]?.current.pendingRobux);
  const totalBalance = sum((r) => r.loader.state.balance);
  const hiddenShares = rows.filter((r) => r.percent == null).length;
  const largest = Math.max(1, ...rows.map((r) => r.periods[90]?.current.totalRobux ?? 0));
  const doneCount = rows.filter((r) => (job === "all" ? r.allDone : r.recentDone) && !r.loader.state.loading).length;

  const exportCsv = () => {
    const head = ["creator", "owned", "earned 7 days", "earned 30 days", "earned 90 days", ...(showAll ? ["earned all time"] : []), "your share %", "your share 90 days", "pending", "balance"];
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.creator.name),
          r.owned ? "yes" : "no",
          ...PERIODS.map((d) => r.periods[d]?.current.totalRobux ?? ""),
          ...(showAll ? [r.all?.totalRobux ?? ""] : []),
          r.percent ?? "",
          share(r, r.periods[90]?.current.totalRobux ?? 0) ?? "",
          r.periods[90]?.current.pendingRobux ?? "",
          r.loader.state.balance ?? "",
        ]
          .map(String)
          .join(","),
      );
    }
    downloadText(`account-overview${showAll ? "-all-time" : ""}.csv`, lines.join("\r\n") + "\r\n", "text/csv");
  };

  const columns = 6 + (showAll ? 1 : 0) + 2;

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
          <span class="rb-muted rb-small">
            {ran.has("all") ? "Last 7, 30 and 90 days, and all time" : ran.has("recent") ? "Last 7, 30 and 90 days" : "Last 7, 30 and 90 days, all at once"}
          </span>
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
              {ran.has("recent") && (
                <button class="rb-btn" onClick={() => run("all")} title="Carries on from where the 90-day report stopped">
                  {ran.has("all") ? "Run all-time report again" : "Run all-time report"}
                </button>
              )}
              <button class="rb-btn rb-btn-primary" onClick={() => run("recent")}>
                {ran.has("recent") ? "Run again" : "Run report"}
              </button>
            </>
          )}
        </div>

        <main class="rb-body rb-report">
          {error && <div class="rb-empty rb-error">{error}</div>}

          {!ran.has("recent") && !running && !stopped && !error && (
            <div class="rb-overview-intro">
              <h3>Earnings for your account and all your groups, side by side</h3>
              <p>
                Press <strong>Run report</strong> to see the last 7, 30 and 90 days for each of them at once. RoBulk loads your selected group first, then the rest one at a
                time, so it can take a few minutes if you have lots of groups. Once it's done, <strong>Run all-time report</strong> carries on from there to your first
                sale.
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
                    {job === "all" ? "All time: " : ""}Now loading {current} ({Math.min(doneCount + 1, loaders.length)} of {loaders.length}).
                  </>
                )}
              </span>
            </div>
          )}
          {stopped && !error && <div class="rb-banner rb-banner-inline">Stopped. Run the report again to carry on from where it got to.</div>}
          {(ran.has("recent") || running) && loaders.length === 0 && !running && !error && <div class="rb-empty">None of your groups let your role see their revenue.</div>}

          {rows.length > 0 && (
            <>
              <div class="rb-kpis">
                {PERIODS.map((d) => (
                  <div class="rb-stat" key={d}>
                    <span class="rb-stat-label">Earned, last {d} days</span>
                    <strong class="rb-stat-value">{robux(totals[d].cur)}</strong>
                    {totals[d].prev > 0 && (
                      <span class={`rb-stat-delta ${totals[d].cur >= totals[d].prev ? "up" : "down"}`}>{changeLabel(totals[d].cur, totals[d].prev)} vs the {d} days before</span>
                    )}
                  </div>
                ))}
                {showAll && (
                  <div class="rb-stat">
                    <span class="rb-stat-label">Earned, all time</span>
                    <strong class="rb-stat-value">{robux(totalAll)}</strong>
                    <span class="rb-stat-hint">Your share: {robux(totalShareAll)}</span>
                  </div>
                )}
                <div class="rb-stat">
                  <span class="rb-stat-label">Your share, last 90 days</span>
                  <strong class="rb-stat-value">{robux(totalShare90)}</strong>
                  <span class="rb-stat-hint">
                    Everything from what you own, plus your payout share of other groups
                    {hiddenShares > 0 ? ` (${hiddenShares} ${hiddenShares === 1 ? "group hides" : "groups hide"} their payouts from your role)` : ""}
                  </span>
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
                        <th class="num">Last 7 days</th>
                        <th class="num">Last 30 days</th>
                        <th>Last 90 days</th>
                        {showAll && <th class="num">All time</th>}
                        <th class="num">Your share, 90 days</th>
                        <th class="num">Pending</th>
                        <th class="num">Balance</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        // A heading where the groups you don't own start.
                        const heading =
                          i === 0 || (rows[i - 1].owned && !r.owned) ? (
                            <tr class="rb-row-heading" key={`h-${r.owned}`}>
                              <th colSpan={columns}>{r.owned ? "Your account and groups you own" : "Groups you don't own: your share is your recurring payout percentage"}</th>
                            </tr>
                          ) : null;
                        const { loading, progress } = r.loader.state;
                        const cell = (d: Period) => {
                          const p = r.periods[d];
                          if (!p) return "—";
                          return (
                            <>
                              {robux(p.current.totalRobux)}
                              {r.recentDone && <div class="rb-small rb-muted">{changeLabel(p.current.totalRobux, p.previous.totalRobux)}</div>}
                            </>
                          );
                        };
                        const earned90 = r.periods[90]?.current.totalRobux ?? 0;
                        const share90 = share(r, earned90);
                        return [
                          heading,
                          <tr key={creatorKey(r.creator)}>
                            <td>
                              <strong>{r.creator.type === "User" ? `${r.creator.name} (you)` : r.creator.name}</strong>
                              {creatorKey(r.creator) === selectedKey && <span class="rb-chip rb-chip-quiet">Selected</span>}
                              {loading && <div class="rb-small rb-muted">{progress ?? "Loading…"}</div>}
                              {!loading && !r.loader.state.entry && <div class="rb-small rb-muted">{running ? "Waiting its turn…" : "Not loaded"}</div>}
                              {!loading && r.loader.state.entry && !r.recentDone && <div class="rb-small rb-muted">Not loaded all the way back yet</div>}
                            </td>
                            <td class="num">{cell(7)}</td>
                            <td class="num">{cell(30)}</td>
                            <td>
                              <div class="rb-overview-bar-cell">
                                <div class="rb-overview-bar" title={robux(earned90)}>
                                  <div style={{ width: `${(earned90 / largest) * 100}%` }} />
                                </div>
                                <span class="rb-overview-value">{cell(90)}</span>
                              </div>
                            </td>
                            {showAll && <td class="num">{r.all ? robux(r.all.totalRobux) : r.loader.state.loading && job === "all" ? "Loading…" : "—"}</td>}
                            <td class="num">
                              {r.percent == null ? (
                                <span class="rb-muted" title="Your role in this group can't see its payout percentages">Hidden</span>
                              ) : r.owned ? (
                                r.periods[90] ? robux(earned90) : "—"
                              ) : (
                                <span title={`${r.percent}% recurring payout`}>
                                  {r.periods[90] ? robux(share90 ?? 0) : "—"} <span class="rb-muted rb-small">({r.percent}%)</span>
                                </span>
                              )}
                            </td>
                            <td class="num">{r.periods[90] ? robux(r.periods[90]!.current.pendingRobux) : "—"}</td>
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
