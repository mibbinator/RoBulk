import { Fragment } from "preact";
import { useMemo } from "preact/hooks";
import type { SaleTransaction } from "../core/earnings";
import { WEEKDAYS, hourLabel, salesTiming } from "../core/salesTiming";
import { ChartCard, robux } from "./charts";

// Experimental: a day-by-hour heatmap of when sales come in. One hue, light
// for few sales and dark for many; every cell says its numbers on hover, and
// the table view lists them by part of the day.

const BLOCKS = [
  ["Night (12–6 AM)", 0, 6],
  ["Morning (6 AM–12 PM)", 6, 12],
  ["Afternoon (12–6 PM)", 12, 18],
  ["Evening (6 PM–12 AM)", 18, 24],
] as const;

export function BestTimes({ transactions, from, to }: { transactions: SaleTransaction[]; from: Date; to: Date }) {
  const timing = useMemo(() => salesTiming(transactions, from, to), [transactions, from.getTime(), to.getTime()]);
  const { sales, robux: earned, max, busiest } = timing;

  const rows = WEEKDAYS.map((day, d) => [
    day,
    ...BLOCKS.map(([, a, b]) => sales[d].slice(a, b).reduce((x, y) => x + y, 0)),
    sales[d].reduce((x, y) => x + y, 0),
  ]);

  return (
    <ChartCard
      wide
      title="Best times to sell"
      subtitle={
        busiest
          ? `Busiest: ${WEEKDAYS[busiest.day]}s around ${hourLabel(busiest.hour)}, in your time zone. Experimental.`
          : "When your sales come in, in your time zone. Experimental."
      }
      table={{ columns: ["Day", ...BLOCKS.map(([label]) => label), "Total"], rows }}
    >
      <div class="rb-heatmap" role="img" aria-label="Sales by day of the week and hour of the day">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} class="rb-heatmap-hour">
            {h % 3 === 0 ? hourLabel(h) : ""}
          </span>
        ))}
        {WEEKDAYS.map((day, d) => (
          <Fragment key={day}>
            <span class="rb-heatmap-day">
              {day.slice(0, 3)}
            </span>
            {sales[d].map((n, h) => (
              <span
                key={`${d}-${h}`}
                class={`rb-heatmap-cell ${n === 0 ? "is-empty" : ""}`}
                style={{ "--level": max ? String(n / max) : "0" }}
                title={`${day} ${hourLabel(h)}: ${n} ${n === 1 ? "sale" : "sales"}${n ? ` (${robux(earned[d][h])})` : ""}`}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div class="rb-heatmap-legend" aria-hidden="true">
        <span>Fewer sales</span>
        <span class="rb-heatmap-scale" />
        <span>More</span>
      </div>
    </ChartCard>
  );
}
