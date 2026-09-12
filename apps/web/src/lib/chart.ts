/** Recharts takes literal colors, so the palette the charts share lives here. */
export const CHART = {
  /** canary-500 — dark enough to read as a line on white. */
  accent: "#e5af0c",
  /** canary-100 — post-change shading. */
  accentWash: "#fdf4c8",
  /** neutral-400 — overlays and reference lines. */
  muted: "#a1a1a1",
  /** neutral-200 — grid. */
  grid: "#e5e5e5",
  /** neutral-500 — axis text. */
  axis: "#737373",
  /** rose-400 — alarm threshold. */
  threshold: "#fb7185",
} as const;

export const TOOLTIP_STYLE = {
  borderRadius: "0.75rem",
  border: "1px solid #e5e5e5",
  boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)",
  fontSize: "0.75rem",
} as const;
