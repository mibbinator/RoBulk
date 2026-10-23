export type Theme = "dark" | "light";

/** Follow the dashboard's own theme by checking its background brightness. */
export function detectTheme(): Theme {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "light" : "dark";
  }
  return "dark";
}
