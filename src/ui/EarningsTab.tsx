import { useEffect } from "preact/hooks";
import type { CategoryId } from "../core/categories";
import { change, type DayPoint, type EarningsSummary } from "../core/earnings";
import { AreaChart, BarChart, ChartCard, DoughnutChart, StatTile, compact, robux, type Slice } from "./charts";
import { Segmented, downloadText, fileSafe } from "./components";
import { rangeLabel, useWorkspace, type ReportRange } from "./workspace";

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
  const { creator, sales, loadSales, stopSales } = useWorkspace();

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
        {sales.error && <div class="rb-empty rb-error">{sales.error}</div>}
        {!s && sales.loading && <div class="rb-empty">{sales.progress}</div>}
        {sales.truncated && !sales.loading && sales.since && (
          <div class="rb-banner rb-banner-inline">
            Showing sales from {longDate(sales.since)} on; loading stopped before {allTime ? "your first sale" : "the start of this range"}.{" "}
            <button class="rb-link-btn" onClick={() => loadSales(sales.range, undefined, { force: true })}>
              Keep loading
            </button>
          </div>
        )}

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
                                {b.label}
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
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
