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
// and 90 days at once (and the periods before them, for the change). The
// all-time report is separate and can run at the same time: both go through
// the creators in turn, and the all-time one carries each creator on from
// wherever its sales have got to.
//
// The group the dashboard has selected goes first in the report, as a normal
// load; everything else is a background load, which waits whenever the
// selected group (or anything the RoBulk panel asks for) is loading. Once the
// selected group has its 180 days, any all-time loading of it carries on in
// the background too, so the other groups aren't held up for hours.
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

interface JobState {
  running: boolean;
  done: boolean;
  stopped: boolean;
  /** The creator it's loading now, and which of how many. */
  current: string | null;
  position: number;
}

const IDLE: JobState = { running: false, done: false, stopped: false, current: null, position: 0 };

export function AccountOverview({ onClose, onOpenCreator }: { onClose: () => void; onOpenCreator: (creator: Creator) => void }) {
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const [loaders, setLoaders] = useState<SalesLoader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<Job, JobState>>({ recent: IDLE, all: IDLE });
  const [preparing, setPreparing] = useState<string | null>(null);
  /** The group the dashboard has selected; its load is RoBulk's own, not the report's. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Recurring payout percentage for each group the user doesn't own (null: not allowed to see it). */
  const [percents, setPercents] = useState<Map<string, number | null>>(new Map());
  const cancelled = useRef<Record<Job, boolean>>({ recent: false, all: false });
  /** Finding the creators happens once, even if both reports start together. */
  const setUpOnce = useRef<Promise<{ list: SalesLoader[]; selected: string }> | null>(null);
  /** Bumped when any loader changes, a few times a second at most. */
  const [tick, setTick] = useState(0);
  const running = jobs.recent.running || jobs.all.running;

  const patch = (which: Job, change: Partial<JobState>) => setJobs((j) => ({ ...j, [which]: { ...j[which], ...change } }));

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

  // Leaving the page part-way through stops the reports; ask first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const stop = (which: Job) => {
    cancelled.current[which] = true;
    const other = which === "recent" ? "all" : "recent";
    // Stop the background loads, unless the other report is still using them. The selected group's
    // load belongs to RoBulk itself.
    if (!jobs[other].running) for (const l of loaders) if (creatorKey(l.creator) !== selectedKey) l.stop();
    patch(which, { running: false, stopped: true, current: null });
  };

  const close = () => {
    if (running && !confirm("A report is still running. Stop it and close?")) return;
    if (jobs.recent.running) stop("recent");
    if (jobs.all.running) stop("all");
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** The creators and their loaders, found once per visit to the overview. */
  const setUp = () =>
    (setUpOnce.current ??= (async () => {
      const settings = await readSettings(storage).catch(() => DEFAULT_SETTINGS);
      const cache = new SalesCache(storage, { maxSales: () => settings.maxStoredSales, overflow: extensionOverflowStore() });
      setPreparing("Finding your groups…");
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
      setPreparing("Checking your payout share in groups you don't own…");
      const notOwned = visible.filter((c) => c.type === "Group" && !c.owned);
      const found = await Promise.all(notOwned.map(async (c) => [creatorKey(c), me ? await payoutPercentage(client, c.id, me.id) : null] as const));
      setPercents(new Map(found));
      setPreparing(null);
      return { list, selected };
    })().catch((e) => {
      setUpOnce.current = null;
      setPreparing(null);
      throw e;
    }));

  const run = async (which: Job) => {
    cancelled.current[which] = false;
    setError(null);
    patch(which, { running: true, stopped: false, current: null, position: 0 });
    try {
      const { list, selected } = await setUp();
      const want = which === "all" ? null : recentWant();
      for (const [i, loader] of list.entries()) {
        if (cancelled.current[which]) return;
        patch(which, { current: loader.creator.name, position: i + 1 });
        const isSelected = creatorKey(loader.creator) === selected;
        // Already loaded far enough back on this visit: nothing to ask Roblox for. All time carries
        // on from wherever this creator's sales have got to, even mid-way through the other report.
        loader.load(want, { background: which === "all" || !isSelected });
        await loader.whenCovers(want);
        // The selected group has its 180 days; if all time is carrying it further, that goes on in
        // the background so the other groups aren't held up behind it.
        if (which === "recent" && isSelected) loader.demote();
      }
      if (!cancelled.current[which]) patch(which, { running: false, done: true, current: null });
    } catch (e) {
      setError(`Couldn't run the report: ${(e as Error).message}`);
      patch(which, { running: false, stopped: true, current: null });
    }
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
  }, [loaders, tick, percents, jobs]);

  const showAll = jobs.all.running || jobs.all.done || rows.some((r) => r.allDone && r.all);
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
  const ranRecent = jobs.recent.done || jobs.recent.running || jobs.recent.stopped;

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
  const jobLine = (which: Job, label: string) => {
    const j = jobs[which];
    if (!j.running) return null;
    return (
      <div>
        {label}: {j.current ? `now loading ${j.current} (${j.position} of ${loaders.length})` : (preparing ?? "starting…")}
      </div>
    );
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
          <span class="rb-muted rb-small">{showAll ? "Last 7, 30 and 90 days, and all time" : "Last 7, 30 and 90 days, all at once"}</span>
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-ghost" disabled={rows.length === 0} onClick={exportCsv}>
            Export (.csv)
          </button>
          {jobs.all.running ? (
            <button class="rb-btn rb-btn-ghost" onClick={() => stop("all")}>
              Stop all-time report
            </button>
          ) : (
            <button class="rb-btn rb-btn-alltime" onClick={() => run("all")} title="Loads every sale back to the first one. It can run at the same time as the report.">
              {jobs.all.done ? "Run all-time report again" : "Run all-time report"}
            </button>
          )}
          {jobs.recent.running ? (
            <button class="rb-btn rb-btn-ghost" onClick={() => stop("recent")}>
              Stop report
            </button>
          ) : (
            <button class="rb-btn rb-btn-primary" onClick={() => run("recent")}>
              {jobs.recent.done ? "Run again" : "Run report"}
            </button>
          )}
        </div>

        <main class="rb-body rb-report">
          {error && <div class="rb-empty rb-error">{error}</div>}
          {showAll && (
            <div class="rb-dev-notice" role="note">
              <strong>Under development.</strong> All time is still under development and may be buggy: totals can be incomplete, and loading a long history can be
              slow or stop part-way. Your other reports aren't affected.
            </div>
          )}

          {!ranRecent && !jobs.all.running && !jobs.all.done && !error && (
            <div class="rb-overview-intro">
              <h3>Earnings for your account and all your groups, side by side</h3>
              <p>
                Press <strong>Run report</strong> to see the last 7, 30 and 90 days for each of them at once. RoBulk loads your selected group first, then the rest one at a
                time, so it can take a few minutes if you have lots of groups. <strong>Run all-time report</strong> loads every sale back to the first one; it takes much
                longer, and can run at the same time.
              </p>
            </div>
          )}

          {running && (
            <div class="rb-banner rb-banner-inline rb-overview-running" role="status">
              <span class="rb-spinner" />
              <span>
                <strong>Keep this tab open and stay on the Creator Dashboard until the reports finish.</strong> Closing the tab or going to another site stops them.
                What's loaded is kept, so running them again carries on.
                {jobLine("recent", "Report")}
                {jobLine("all", "All time")}
              </span>
            </div>
          )}
          {(jobs.recent.stopped || jobs.all.stopped) && !running && !error && (
            <div class="rb-banner rb-banner-inline">Stopped. Run the report again to carry on from where it got to.</div>
          )}
          {(jobs.recent.done || jobs.all.done) && loaders.length === 0 && !error && <div class="rb-empty">None of your groups let your role see their revenue.</div>}

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
                    <span class="rb-stat-hint">
                      Your share: {robux(totalShareAll)}
                      {rows.some((r) => !r.allDone) ? " (only accounts and groups loaded all the way back)" : ""}
                    </span>
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
                            {showAll && <td class="num">{r.all ? robux(r.all.totalRobux) : loading && jobs.all.running ? "Loading…" : "—"}</td>}
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
