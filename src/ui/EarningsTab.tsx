import { useEffect } from "preact/hooks";
import type { CategoryId } from "../core/categories";
import { change, type EarningsSummary } from "../core/earnings";
import { AreaChart, BarChart, ChartCard, DoughnutChart, StatTile, compact, robux, type Slice } from "./charts";
import { Segmented, downloadText, fileSafe } from "./components";
import { useWorkspace, type RangeDays } from "./workspace";

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

function reportCsv(s: EarningsSummary): string {
  const lines = ["date,robux,sales", ...s.daily.map((d) => `${d.date},${d.robux},${d.sales}`), "", "item,robux,sales"];
  for (const i of s.topItems) lines.push(`"${i.label.replace(/"/g, '""')}",${i.robux},${i.sales}`);
  return lines.join("\r\n") + "\r\n";
}

export function EarningsTab() {
  const { creator, sales, loadSales } = useWorkspace();

  // Load on open; the workspace reloads it after a creator switch.
  useEffect(() => {
    if (creator && !sales.loadedAt && !sales.loading && !sales.error) loadSales(sales.range);
  }, [creator]);

  const s = sales.current;
  const p = sales.previous;

  return (
    <>
      <div class="rb-toolbar">
        <Segmented<`${RangeDays}`>
          label="Date range"
          value={`${sales.range}` as `${RangeDays}`}
          onChange={(v) => loadSales(Number(v) as RangeDays)}
          options={[
            ["7", "Last 7 days"],
            ["30", "Last 30 days"],
            ["90", "Last 90 days"],
          ]}
        />
        <div class="rb-spacer" />
        {sales.loadedAt && <span class="rb-muted rb-small">Updated {sales.loadedAt.toLocaleTimeString()}</span>}
        <button class="rb-btn rb-btn-ghost" disabled={!s} onClick={() => s && creator && downloadText(`${fileSafe(creator.name)}-earnings-${sales.range}d.csv`, reportCsv(s), "text/csv")}>
          Export report (.csv)
        </button>
        <button class="rb-btn rb-btn-ghost" disabled={sales.loading} onClick={() => loadSales(sales.range)}>
          Refresh
        </button>
      </div>

      <main class={`rb-body rb-report ${sales.loading && s ? "is-refreshing" : ""}`}>
        {sales.error && <div class="rb-empty rb-error">{sales.error}</div>}
        {!s && sales.loading && <div class="rb-empty">{sales.progress}</div>}
        {sales.truncated && (
          <div class="rb-banner rb-banner-inline">This store has a lot of sales, so the report covers the most recent 6,000 transactions. Older days in the range may be incomplete.</div>
        )}

        {s && (
          <>
            <div class="rb-kpis">
              <StatTile label={`Earned, last ${sales.range} days`} value={robux(s.totalRobux)} delta={p ? change(s.totalRobux, p.totalRobux) : undefined} />
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
                  title="Daily earnings"
                  subtitle="Robux credited per day, after Roblox's share"
                  table={{ columns: ["Date", "Earned", "Sales"], rows: s.daily.map((d) => [d.date, robux(d.robux), d.sales]) }}
                >
                  <AreaChart labels={s.daily.map((d) => shortDate(d.date))} values={s.daily.map((d) => d.robux)} />
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
                  title="Sales per day"
                  subtitle="Number of purchases"
                  table={{ columns: ["Date", "Sales"], rows: s.daily.map((d) => [d.date, d.sales]) }}
                >
                  <BarChart labels={s.daily.map((d) => shortDate(d.date))} values={s.daily.map((d) => d.sales)} format={(n) => `${compact(n)} sales`} />
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
