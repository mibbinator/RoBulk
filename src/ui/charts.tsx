import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from "chart.js";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

Chart.register(LineController, BarController, DoughnutController, LineElement, BarElement, ArcElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler);

// Chart colors are CSS custom properties on .rb-root (light and dark steps of
// the same validated palette), read at draw time so charts follow the theme.

function token(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
}

export const SERIES_COUNT = 8;
export const seriesVar = (slot: number) => (slot < 0 ? "--rb-series-neutral" : `--rb-series-${(slot % SERIES_COUNT) + 1}`);

function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const compact = (n: number) =>
  Math.abs(n) >= 1000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n) : n.toLocaleString("en-US");

export const robux = (n: number) => `R$${Math.round(n).toLocaleString("en-US")}`;

/** Vertical hairline that follows the hovered x position on line charts. */
const crosshair: Plugin<"line"> = {
  id: "rbCrosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = token(chart.canvas, "--rb-axis");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function useChart(build: (canvas: HTMLCanvasElement) => ChartConfiguration, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, build(ref.current));
    return () => chart.destroy();
  }, deps);
  return ref;
}

function baseTooltip(canvas: Element) {
  return {
    backgroundColor: token(canvas, "--rb-surface"),
    borderColor: token(canvas, "--rb-border"),
    borderWidth: 1,
    titleColor: token(canvas, "--rb-muted"),
    bodyColor: token(canvas, "--rb-text"),
    titleFont: { weight: "normal" as const, size: 12 },
    bodyFont: { weight: "bold" as const, size: 13 },
    padding: 10,
    displayColors: false,
    cornerRadius: 8,
  };
}

function axes(canvas: Element, { horizontal = false, format = compact }: { horizontal?: boolean; format?: (n: number) => string } = {}) {
  const grid = { color: token(canvas, "--rb-grid"), lineWidth: 1, drawTicks: false };
  const muted = token(canvas, "--rb-muted");
  const value = { grid, border: { display: false }, ticks: { color: muted, padding: 8, maxTicksLimit: 5, callback: (v: number | string) => format(Number(v)) }, beginAtZero: true };
  // Horizontal bars get a row per label, so every label is shown.
  const category = { grid: { display: false }, border: { color: token(canvas, "--rb-axis") }, ticks: { color: muted, padding: 6, autoSkip: !horizontal, maxRotation: 0 } };
  return horizontal ? { x: value, y: category } : { x: category, y: value };
}

export function AreaChart({ labels, values, format = robux, height = 220 }: { labels: string[]; values: number[]; format?: (n: number) => string; height?: number }) {
  const ref = useChart(
    (canvas) => {
      const color = token(canvas, seriesVar(0));
      return {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              data: values,
              borderColor: color,
              backgroundColor: withAlpha(color, 0.1),
              borderWidth: 2,
              fill: "origin",
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 5,
              pointHoverBackgroundColor: color,
              pointHoverBorderColor: token(canvas, "--rb-surface"),
              pointHoverBorderWidth: 2,
              borderCapStyle: "round",
              borderJoinStyle: "round",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: "index", intersect: false },
          scales: axes(canvas, { format: compact }),
          plugins: { tooltip: { ...baseTooltip(canvas), callbacks: { label: (c) => format(Number(c.raw)) } } },
        },
        plugins: [crosshair],
      } as ChartConfiguration;
    },
    [labels.join("|"), values.join("|")],
  );
  return (
    <div class="rb-chart" style={{ height: `${height}px` }}>
      <canvas ref={ref} role="img" aria-label="Line chart" />
    </div>
  );
}

export interface Slice {
  label: string;
  value: number;
  /** Fixed palette slot for this entity (-1 = neutral), so colors never depend on rank. */
  slot: number;
}

export function DoughnutChart({ slices, format = robux, centerLabel }: { slices: Slice[]; format?: (n: number) => string; centerLabel?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const ref = useChart(
    (canvas) => ({
      type: "doughnut",
      data: {
        labels: slices.map((s) => s.label),
        datasets: [
          {
            data: slices.map((s) => s.value),
            backgroundColor: slices.map((s) => token(canvas, seriesVar(s.slot))),
            borderColor: token(canvas, "--rb-surface"),
            borderWidth: 2,
            hoverOffset: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: "64%",
        plugins: {
          tooltip: {
            ...baseTooltip(canvas),
            callbacks: {
              title: (items) => items[0]?.label ?? "",
              label: (c) => `${format(Number(c.raw))} · ${total ? Math.round((Number(c.raw) / total) * 100) : 0}%`,
            },
          },
        },
      },
    }),
    [slices.map((s) => `${s.label}:${s.value}:${s.slot}`).join("|")],
  );
  return (
    <div class="rb-doughnut">
      <div class="rb-doughnut-canvas">
        <canvas ref={ref} role="img" aria-label="Doughnut chart" />
        {centerLabel && (
          <div class="rb-doughnut-center">
            <strong>{format(total)}</strong>
            <span>{centerLabel}</span>
          </div>
        )}
      </div>
      <ul class="rb-legend">
        {slices.map((s) => (
          <li key={s.label}>
            <span class="rb-swatch" style={{ background: `var(${seriesVar(s.slot)})` }} />
            <span class="rb-legend-label">{s.label}</span>
            <span class="rb-legend-value">{format(s.value)}</span>
            <span class="rb-legend-pct">{total ? Math.round((s.value / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BarChart({
  labels,
  values,
  format = robux,
  horizontal = false,
  height,
}: {
  labels: string[];
  values: number[];
  format?: (n: number) => string;
  horizontal?: boolean;
  height?: number;
}) {
  const h = height ?? (horizontal ? Math.max(120, labels.length * 32 + 30) : 200);
  const ref = useChart(
    (canvas) => ({
      type: "bar",
      data: {
        labels: labels.map((l) => (horizontal && l.length > 28 ? `${l.slice(0, 27)}…` : l)),
        datasets: [
          {
            data: values,
            backgroundColor: token(canvas, seriesVar(0)),
            hoverBackgroundColor: token(canvas, "--rb-primary-hover"),
            maxBarThickness: 24,
            borderRadius: 4,
            borderSkipped: "start",
          },
        ],
      },
      options: {
        indexAxis: horizontal ? "y" : "x",
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: axes(canvas, { horizontal, format: compact }),
        plugins: {
          tooltip: {
            ...baseTooltip(canvas),
            callbacks: { title: (items) => labels[items[0]?.dataIndex ?? 0] ?? "", label: (c) => format(Number(c.raw)) },
          },
        },
      },
    }),
    [labels.join("|"), values.join("|"), horizontal],
  );
  return (
    <div class="rb-chart" style={{ height: `${h}px` }}>
      <canvas ref={ref} role="img" aria-label="Bar chart" />
    </div>
  );
}

/** A titled card with a chart and an equivalent table view. */
export function ChartCard({
  title,
  subtitle,
  table,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  table: { columns: string[]; rows: (string | number)[][] };
  children: ComponentChildren;
  wide?: boolean;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section class={`rb-card ${wide ? "rb-card-wide" : ""}`}>
      <header class="rb-card-header">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button class="rb-link-btn" onClick={() => setShowTable(!showTable)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </header>
      {showTable ? (
        <div class="rb-table-wrap">
          <table class="rb-table">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

export function StatTile({ label, value, delta, hint }: { label: string; value: string; delta?: number | null; hint?: string }) {
  return (
    <div class="rb-stat">
      <span class="rb-stat-label">{label}</span>
      <strong class="rb-stat-value">{value}</strong>
      {delta !== undefined && (
        <span class={`rb-stat-delta ${delta == null ? "" : delta >= 0 ? "up" : "down"}`}>
          {delta == null ? "New this period" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}% vs previous period`}
        </span>
      )}
      {hint && <span class="rb-stat-hint">{hint}</span>}
    </div>
  );
}
