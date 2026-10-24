import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cachedCreators, payoutPercentage } from "../api/account";
import { createClient } from "../api/http";
import type { Creator } from "../api/types";
import { change, summarize } from "../core/earnings";
import { extensionOverflowStore } from "../core/overflowStore";
import { OVERVIEW_PERIODS as PERIODS, readOverview, writeOverview, type OverviewPeriod as Period, type OverviewRow, type SavedOverview } from "../core/overviewCache";
import { SalesCache, cacheCovers } from "../core/salesCache";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../core/settings";
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
//
// With "Remember the account overview" on, the last report is saved and shows
// when the overview opens, marked with when it's from. Running a report again
// shows each creator's saved numbers until its new load gets as far.

const DAY = 86_400_000;
/** What "Run report" loads: the longest period and the one before it. */
const recentWant = () => new Date(Date.now() - 90 * 2 * DAY);

interface Row extends OverviewRow {
  /** Its loader, once a report has been run on this visit. */
  loader: SalesLoader | null;
  /** The numbers are from the saved report: this visit's load hasn't got as far yet. */
  saved: boolean;
}

function summaries(loader: SalesLoader): Pick<OverviewRow, "periods" | "all" | "recentDone" | "asOf"> | null {
  const entry = loader.state.entry;
  if (!entry) return null;
  const now = new Date();
  const periods: OverviewRow["periods"] = {};
  for (const days of PERIODS) {
    const start = new Date(now.getTime() - (days - 1) * DAY);
    const prevEnd = new Date(start.getTime() - DAY);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY);
    const current = summarize(entry.sales, start, now);
    periods[days] = { cur: current.totalRobux, prev: summarize(entry.sales, prevStart, prevEnd).totalRobux, pending: current.pendingRobux };
  }
  const first = entry.coveredFrom ?? entry.sales.at(-1)?.created ?? now.toISOString();
  const all = cacheCovers(entry, null) ? summarize(entry.sales, new Date(first), now).totalRobux : null;
  return { periods, all, recentDone: cacheCovers(entry, recentWant()), asOf: entry.updatedAt };
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

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
  const settingsRead = useMemo(() => readSettings(storage).catch(() => DEFAULT_SETTINGS), [storage]);
  /** The last report, if "Remember the account overview" is on. */
  const [saved, setSaved] = useState<SavedOverview | null>(null);
  const remember = useRef(false);
  /** Whether "Remember the account overview" is on (null until read), and whether the offer to turn it on was waved away. */
  const [rememberOn, setRememberOn] = useState<boolean | null>(null);
  const [offerClosed, setOfferClosed] = useState(false);
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
    settingsRead.then(async (settings) => {
      remember.current = settings.rememberOverview;
      setRememberOn(settings.rememberOverview);
      if (settings.rememberOverview) setSaved(await readOverview(storage));
    });
  }, []);

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
      const settings = await settingsRead;
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
    const before = new Map((saved?.rows ?? []).map((r) => [creatorKey(r.creator), r]));
    const list =
      loaders.length === 0
        ? [...before.values()].map((r): Row => ({ ...r, loader: null, saved: true }))
        : loaders.map((loader): Row => {
            const key = creatorKey(loader.creator);
            const old = before.get(key);
            const owned = loader.creator.type === "User" || loader.creator.owned === true;
            const percent = owned ? 100 : percents.has(key) ? (percents.get(key) ?? null) : (old?.percent ?? null);
            const base = { creator: loader.creator, owned, percent, loader, balance: loader.state.balance };
            const live = summaries(loader);
            // Until this visit's load gets as far back as the saved report did, the saved numbers show.
            if (old && (!live || (!live.recentDone && live.all == null && (old.recentDone || old.all != null)))) {
              return { ...old, ...base, balance: base.balance ?? old.balance, saved: true };
            }
            if (!live) return { ...base, periods: {}, all: null, recentDone: false, asOf: "", saved: false };
            // An all-time total from an earlier report stays until this one gets that far back.
            const carried = live.all == null && old?.all != null ? { all: old.all, allAsOf: old.allAsOf ?? old.asOf } : {};
            return { ...base, ...live, ...carried, saved: false };
          });
    // Your account, then the groups you own, then the rest.
    const rank = (r: Row) => (r.creator.type === "User" ? 0 : r.owned ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b));
    // Also redone when a report finishes, so the last group's numbers show straight away.
  }, [loaders, tick, percents, jobs, saved]);

  // Save the report as it fills in (every few seconds at most), and when the overview closes.
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persist = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const list = rowsNow.current;
    if (!remember.current || !list.some((r) => !r.saved && r.asOf)) return;
    writeOverview(
      storage,
      list.filter((r) => r.asOf).map(({ loader: _loader, saved: _saved, ...r }) => r),
    );
  };
  useEffect(() => {
    if (loaders.length > 0 && remember.current) saveTimer.current ??= setTimeout(persist, 3000);
  }, [rows]);
  useEffect(() => persist, []);

  /** Turns on "Remember the account overview" (the same switch as in RoBulk's Options) and saves this report. */
  const rememberReports = async () => {
    const settings = await readSettings(storage).catch(() => DEFAULT_SETTINGS);
    await writeSettings(storage, { ...settings, rememberOverview: true });
    remember.current = true;
    setRememberOn(true);
    persist();
  };

  const showAll = jobs.all.running || jobs.all.done || rows.some((r) => r.all != null);
  const sum = (pick: (r: Row) => number | null | undefined) => rows.reduce((total, r) => total + (pick(r) ?? 0), 0);
  const totals = Object.fromEntries(PERIODS.map((d) => [d, { cur: sum((r) => r.periods[d]?.cur), prev: sum((r) => r.periods[d]?.prev) }])) as Record<
    Period,
    { cur: number; prev: number }
  >;
  const totalShare90 = sum((r) => share(r, r.periods[90]?.cur ?? 0));
  const totalAll = sum((r) => r.all);
  const totalShareAll = sum((r) => (r.all != null ? share(r, r.all) : 0));
  const totalPending = sum((r) => r.periods[90]?.pending);
  const totalBalance = sum((r) => r.balance);
  const hiddenShares = rows.filter((r) => r.percent == null).length;
  const largest = Math.max(1, ...rows.map((r) => r.periods[90]?.cur ?? 0));
  const ranRecent = jobs.recent.done || jobs.recent.running || jobs.recent.stopped;
  /** When the oldest saved numbers on show are from. */
  const savedFrom = rows
    .filter((r) => r.saved)
    .map((r) => r.asOf)
    .sort()[0];

  const exportCsv = () => {
    const head = ["creator", "owned", "earned 7 days", "earned 30 days", "earned 90 days", ...(showAll ? ["earned all time"] : []), "your share %", "your share 90 days", "pending", "balance"];
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.creator.name),
          r.owned ? "yes" : "no",
          ...PERIODS.map((d) => r.periods[d]?.cur ?? ""),
          ...(showAll ? [r.all ?? ""] : []),
          r.percent ?? "",
          share(r, r.periods[90]?.cur ?? 0) ?? "",
          r.periods[90]?.pending ?? "",
          r.balance ?? "",
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

          {!ranRecent && !jobs.all.running && !jobs.all.done && !error && !savedFrom && (
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
          {savedFrom && !running && (
            <div class="rb-banner rb-banner-inline" role="note">
              {loaders.length === 0 ? "Showing the report saved" : "Some numbers are from the report saved"} {when(savedFrom)}. Run the report to bring{" "}
              {loaders.length === 0 ? "it" : "them"} up to date.
            </div>
          )}
          {rememberOn === false && !offerClosed && (ranRecent || jobs.all.running || jobs.all.done || jobs.all.stopped) && (
            <div class="rb-banner rb-banner-inline rb-remember-offer" role="note">
              <span>
                This report won't be kept once you close the overview. Turn on <strong>Remember the account overview</strong> to see it straight away next time; you
                can switch it off again in RoBulk's Options.
              </span>
              <button class="rb-btn rb-btn-primary" onClick={rememberReports}>
                Remember it
              </button>
              <button class="rb-btn rb-btn-ghost" onClick={() => setOfferClosed(true)}>
                Not now
              </button>
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
                      {rows.some((r) => r.all == null) ? " (only accounts and groups loaded all the way back)" : ""}
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
                        const loading = r.loader?.state.loading ?? false;
                        const note = loading
                          ? (r.loader?.state.progress ?? "Loading…")
                          : r.saved
                            ? `${running ? "Waiting its turn · " : ""}From ${when(r.asOf)}`
                            : !r.asOf
                              ? running
                                ? "Waiting its turn…"
                                : "Not loaded"
                              : !r.recentDone
                                ? "Not loaded all the way back yet"
                                : null;
                        const cell = (d: Period) => {
                          const p = r.periods[d];
                          if (!p) return "—";
                          return (
                            <>
                              {robux(p.cur)}
                              {r.recentDone && <div class="rb-small rb-muted">{changeLabel(p.cur, p.prev)}</div>}
                            </>
                          );
                        };
                        const earned90 = r.periods[90]?.cur ?? 0;
                        const share90 = share(r, earned90);
                        return [
                          heading,
                          <tr key={creatorKey(r.creator)}>
                            <td>
                              <strong>{r.creator.type === "User" ? `${r.creator.name} (you)` : r.creator.name}</strong>
                              {creatorKey(r.creator) === selectedKey && <span class="rb-chip rb-chip-quiet">Selected</span>}
                              {note && <div class="rb-small rb-muted">{note}</div>}
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
                            {showAll && (
                              <td class="num">
                                {r.all != null ? (
                                  <span title={r.allAsOf ? `From the report on ${when(r.allAsOf)}` : undefined}>{robux(r.all)}</span>
                                ) : loading && jobs.all.running ? (
                                  "Loading…"
                                ) : (
                                  "—"
                                )}
                              </td>
                            )}
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
                            <td class="num">{r.periods[90] ? robux(r.periods[90]!.pending) : "—"}</td>
                            <td class="num">{r.balance == null ? "—" : robux(r.balance)}</td>
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
