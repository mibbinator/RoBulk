import { useEffect, useState } from "preact/hooks";
import type { CategoryId } from "../core/categories";
import { change, type DayPoint, type EarningsSummary } from "../core/earnings";
import { userNames } from "../api/account";
import { markSeen, readSeen, salesSince } from "../core/seenSales";
import { BestTimes } from "./BestTimes";
import { AreaChart, BarChart, ChartCard, DoughnutChart, StatTile, compact, robux, type Slice } from "./charts";
import { Segmented, downloadText, fileSafe } from "./components";
import { creatorKey, rangeLabel, useWorkspace, type ReportRange } from "./workspace";

// Each category keeps the same color everywhere, whatever its rank.
const CATEGORY_SLOT: Record<CategoryId | "otherFold", number> = {
  shirts: 0,
  pants: 1,
  tshirts: 2,
  accessories: 3,
  layered: 4,
  gamePasses: 5,
  heads: 6,
  devProducts: 7,
  other: -1,
  otherFold: -1,
};

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
// Weekly charts can span years, so they include the year.
const weekDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

function reportCsv(points: DayPoint[], weekly: boolean, s: EarningsSummary): string {
  const lines = [`${weekly ? "week starting" : "date"},robux,sales`, ...points.map((d) => `${d.date},${d.robux},${d.sales}`), "", "item,robux,sales"];
  for (const i of s.topItems) lines.push(`"${i.label.replace(/"/g, '""')}",${i.robux},${i.sales}`);
  return lines.join("\r\n") + "\r\n";
}

export function EarningsTab() {
  const { client, creator, sales, loadSales, stopSales, storage, salesEntry, scopedSales, settings, universeId, experience, gameStats } = useWorkspace();

  // Roblox's transaction records give buyers' ids but not their names; look up the ones shown.
  const [buyerNames, setBuyerNames] = useState<Map<string, string>>(new Map());
  const unnamed = (sales.current?.topBuyers ?? []).filter((b) => !b.label && !buyerNames.has(b.key) && Number(b.key) > 0).map((b) => Number(b.key));
  useEffect(() => {
    if (unnamed.length === 0) return;
    userNames(client, unnamed)
      .then((found) => setBuyerNames((prev) => new Map([...prev, ...[...found].map(([id, name]) => [String(id), name] as [string, string])])))
      .catch(() => {});
  }, [unnamed.join(",")]);
  const buyerName = (b: { key: string; label: string }) => b.label || buyerNames.get(b.key) || `User ${b.key}`;
  /** When this creator's report was last opened before now, for the "since you last looked" line. */
  const [lastLooked, setLastLooked] = useState<{ key: string; at: string | null } | null>(null);

  // Opening the report counts as looking: remember when, and clear the sidebar's count.
  useEffect(() => {
    if (!creator) return;
    const key = creatorKey(creator);
    let current = true;
    readSeen(storage, key).then((at) => {
      if (!current) return;
      setLastLooked({ key, at });
      markSeen(storage, key).catch(() => {});
    });
    return () => {
      current = false;
    };
  }, [creator]);
  const sinceLast = lastLooked?.at && creator && lastLooked.key === creatorKey(creator) && salesEntry ? salesSince(scopedSales, lastLooked.at) : null;

  // Load on open; the workspace reloads it after a creator switch.
  useEffect(() => {
    if (creator && !sales.loadedAt && !sales.loading && !sales.error) loadSales(sales.range);
  }, [creator]);

  const s = sales.current;
  const p = sales.previous;
  const allTime = sales.range === "all";
  const weekly = s?.bucket === "week";
  const points = s?.daily ?? [];
  const label = (d: DayPoint) => (weekly ? weekDate(d.date) : shortDate(d.date));
  const unit = weekly ? "week" : "day";

  return (
    <>
      <div class="rb-toolbar">
        <Segmented<string>
          label="Date range"
          value={String(sales.range)}
          onChange={(v) => loadSales(v === "all" ? "all" : (Number(v) as ReportRange))}
          options={[
            ["7", "Last 7 days"],
            ["30", "Last 30 days"],
            ["90", "Last 90 days"],
            ["all", "All time"],
          ]}
        />
        <div class="rb-spacer" />
        {sales.loading && s ? (
          <span class="rb-muted rb-small rb-updating">
            <span class="rb-spinner" /> Updating…
          </span>
        ) : (
          sales.loadedAt && <span class="rb-muted rb-small">Updated {sales.loadedAt.toLocaleTimeString()}</span>
        )}
        {sales.loading ? (
          <button class="rb-btn rb-btn-ghost" onClick={stopSales} title="Stop loading and show what's loaded so far">
            Stop
          </button>
        ) : (
          <>
            <button
              class="rb-btn rb-btn-ghost"
              disabled={!s}
              onClick={() => s && creator && downloadText(`${fileSafe(creator.name)}-earnings-${allTime ? "all-time" : `${sales.range}d`}.csv`, reportCsv(points, weekly, s), "text/csv")}
            >
              Export report (.csv)
            </button>
            <button class="rb-btn rb-btn-ghost" onClick={() => loadSales(sales.range, undefined, { force: true })} title="Fetch the latest sales from Roblox">
              Refresh
            </button>
          </>
        )}
      </div>

      <main class="rb-body rb-report">
        {sinceLast && lastLooked?.at && (
          <p class="rb-since-last">
            {sinceLast.count === 0
              ? "No new sales"
              : `${sinceLast.count.toLocaleString()} new ${sinceLast.count === 1 ? "sale" : "sales"} (${robux(sinceLast.robux)})`}{" "}
            since you last looked, on {new Date(lastLooked.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
          </p>
        )}
        {sales.error && <div class="rb-empty rb-error">{sales.error}</div>}
        {!s && sales.loading && <div class="rb-empty">{sales.progress}</div>}
        {s && sales.partial && (
          <div class="rb-banner rb-banner-inline rb-filling" role="status">
            <div class={`rb-progress-bar ${sales.fraction == null ? "is-indeterminate" : ""}`}>
              <div style={{ width: sales.fraction == null ? undefined : `${Math.round(sales.fraction * 100)}%` }} />
            </div>
            <span>
              {sales.progress} The report fills in as they arrive, and everything loaded is saved, so you can leave and come back.
            </span>
          </div>
        )}
        {sales.truncated && !sales.loading && sales.since && (
          <div class="rb-banner rb-banner-inline">
            Showing sales from {longDate(sales.since)} on; loading stopped before {allTime ? "your first sale" : "the start of this range"}.{" "}
            <button class="rb-link-btn" onClick={() => loadSales(sales.range, undefined, { force: true })}>
              Keep loading
            </button>
          </div>
        )}

        {universeId != null && (
          <section class="rb-game-head">
            <h3>{experience?.name ?? gameStats?.name ?? "Experience"}</h3>
            <p class="rb-muted rb-small">This experience's stats, and the sales of its game passes and developer products. Your clothing store has its own report.</p>
            {gameStats && (
              <div class="rb-kpis">
                <StatTile label="Visits" value={gameStats.visits.toLocaleString()} />
                <StatTile label="Playing now" value={gameStats.playing.toLocaleString()} />
                <StatTile label="Favorites" value={gameStats.favorites.toLocaleString()} />
                <StatTile
                  label="Rating"
                  value={gameStats.upVotes != null && gameStats.downVotes != null && gameStats.upVotes + gameStats.downVotes > 0 ? `${Math.round((gameStats.upVotes / (gameStats.upVotes + gameStats.downVotes)) * 100)}%` : "—"}
                  hint={gameStats.upVotes != null ? `${gameStats.upVotes.toLocaleString()} likes, ${(gameStats.downVotes ?? 0).toLocaleString()} dislikes` : undefined}
                />
              </div>
            )}
          </section>
        )}
        {universeId == null && s && <p class="rb-muted rb-small rb-scope-note">Sales of your clothing and accessories. Game pass and developer product sales are in each experience's report (pick one in the menu at the top).</p>}

        {s && (
          <>
            <div class="rb-kpis">
              <StatTile
                label={`Earned, ${rangeLabel(sales.range)}`}
                value={robux(s.totalRobux)}
                delta={p ? change(s.totalRobux, p.totalRobux) : undefined}
                hint={allTime && sales.since ? `Since ${longDate(sales.since)}` : undefined}
              />
              <StatTile label="Sales" value={s.sales.toLocaleString()} delta={p ? change(s.sales, p.sales) : undefined} />
              <StatTile label="Average per sale" value={robux(s.averagePerSale)} />
              <StatTile label="Unique buyers" value={s.uniqueBuyers.toLocaleString()} />
              <StatTile label="Pending" value={robux(s.pendingRobux)} hint="Recent sales Roblox hasn't released yet" />
              {sales.balance != null && <StatTile label="Current balance" value={robux(sales.balance)} />}
            </div>

            {s.sales === 0 ? (
              <div class="rb-empty">No sales in this period yet.</div>
            ) : (
              <div class="rb-grid">
                <ChartCard
                  wide
                  title={weekly ? "Weekly earnings" : "Daily earnings"}
                  subtitle={`Robux credited per ${unit}, after Roblox's share`}
                  table={{ columns: [weekly ? "Week starting" : "Date", "Earned", "Sales"], rows: points.map((d) => [d.date, robux(d.robux), d.sales]) }}
                >
                  <AreaChart labels={points.map(label)} values={points.map((d) => d.robux)} />
                </ChartCard>

                <ChartCard
                  title="Earnings by category"
                  table={{ columns: ["Category", "Earned", "Sales"], rows: s.byCategory.map((c) => [c.label, robux(c.robux), c.sales]) }}
                >
                  <DoughnutChart
                    centerLabel="total"
                    slices={s.byCategory.map((c): Slice => ({ label: c.label, value: c.robux, slot: CATEGORY_SLOT[c.category] }))}
                  />
                </ChartCard>

                <ChartCard
                  title="Top items"
                  subtitle="By Robux earned"
                  table={{ columns: ["Item", "Earned", "Sales"], rows: s.topItems.map((i) => [i.label, robux(i.robux), i.sales]) }}
                >
                  <BarChart horizontal labels={s.topItems.map((i) => i.label)} values={s.topItems.map((i) => i.robux)} />
                </ChartCard>

                <ChartCard
                  title={`Sales per ${unit}`}
                  subtitle="Number of purchases"
                  table={{ columns: [weekly ? "Week starting" : "Date", "Sales"], rows: points.map((d) => [d.date, d.sales]) }}
                >
                  <BarChart labels={points.map(label)} values={points.map((d) => d.sales)} format={(n) => `${compact(n)} sales`} />
                </ChartCard>

                <section class="rb-card">
                  <header class="rb-card-header">
                    <div>
                      <h3>Top buyers</h3>
                      <p>Who spent the most in this period</p>
                    </div>
                  </header>
                  <div class="rb-table-wrap">
                    <table class="rb-table">
                      <thead>
                        <tr>
                          <th>Buyer</th>
                          <th class="num">Purchases</th>
                          <th class="num">Earned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.topBuyers.map((b) => (
                          <tr key={b.key}>
                            <td>
                              <a href={`https://www.roblox.com/users/${b.key}/profile`} target="_blank" rel="noreferrer">
                                {buyerName(b)}
                              </a>
                            </td>
                            <td class="num">{b.sales}</td>
                            <td class="num">{robux(b.robux)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {settings.bestTimes && salesEntry && sales.since && <BestTimes transactions={scopedSales} from={new Date(sales.since)} to={new Date()} />}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
