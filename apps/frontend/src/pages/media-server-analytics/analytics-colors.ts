/**
 * Centralized analytics color language (dataviz-validated). Never scatter chart
 * colors — import from here.
 *
 * - Playback methods are STATUS-like: reserved hues, always shipped with a label.
 * - Media types are categorical-by-entity.
 * - CHART_SERIES is the validated categorical palette (fixed order, never cycled
 *   past 8 — fold extras into "Other"). Validated for the dark surface via the
 *   dataviz validator (CVD in the 8–12 floor band, legal with the legends +
 *   direct labels every chart here carries).
 */

// Playback method — Direct Play green · Direct Stream blue · Transcode orange · Unknown gray.
export const PLAYBACK_COLORS: Record<string, string> = {
  directplay: '#0ca30c',
  'direct play': '#0ca30c',
  directstream: '#3987e5',
  'direct stream': '#3987e5',
  transcode: '#d95926',
  unknown: '#8a8a83',
};

// Media types — Movies indigo · TV cyan · Music pink · Documentary green · Other gray.
export const MEDIA_TYPE_COLORS: Record<string, string> = {
  movie: '#9085e9',
  tv: '#22b8cf',
  episode: '#22b8cf',
  anime: '#22b8cf',
  music: '#d55181',
  documentary: '#199e70',
  other: '#8a8a83',
};

// Validated categorical series palette (dark). Fixed order — never cycled past 8.
export const CHART_SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926', '#008300'];
export const OTHER_COLOR = '#8a8a83';

// Chart theme constants — match the existing dark recharts styling.
export const CHART = {
  grid: 'hsl(240 14% 18%)',
  tick: 'hsl(240 8% 60%)',
  tooltipBg: 'hsl(240 22% 7%)',
  tooltipBorder: 'hsl(240 14% 18%)',
  tooltipLabel: 'hsl(240 8% 70%)',
} as const;

export function seriesColor(i: number): string {
  return i < CHART_SERIES.length ? CHART_SERIES[i] : OTHER_COLOR;
}

export function playbackColor(method?: string | null): string {
  return PLAYBACK_COLORS[(method ?? 'unknown').toLowerCase()] ?? PLAYBACK_COLORS.unknown;
}

export function mediaTypeColor(type?: string | null): string {
  return MEDIA_TYPE_COLORS[(type ?? 'other').toLowerCase()] ?? MEDIA_TYPE_COLORS.other;
}

/** Ordered playback-method series for the transcode trend — reserved colors, stable order. */
export const TREND_METHODS = [
  { key: 'directplay', color: '#0ca30c' },
  { key: 'directstream', color: '#3987e5' },
  { key: 'transcode', color: '#d95926' },
  { key: 'other', color: OTHER_COLOR },
] as const;

/**
 * Single-hue sequential ramp for the activity heatmap: an empty cell sits just
 * above the surface; busier cells deepen toward a saturated blue. `intensity` is
 * 0..1 (cell plays / peak). One hue, light→dark — a proper sequential scale.
 */
export function heatColor(intensity: number): string {
  if (intensity <= 0) return 'hsl(240 14% 12%)';
  const alpha = 0.12 + 0.88 * Math.min(1, intensity);
  return `rgba(57, 135, 229, ${alpha.toFixed(3)})`;
}

/** A folded distribution slice, carrying the values it stands for. */
export interface FoldedSlice {
  name: string;
  plays: number;
  color: string;
  /**
   * The underlying values this slice was built from — one for a normal bar, and for
   * the gray "Other" bar, every value that was folded into it. Without this, clicking
   * "Other" has no filter to drill on: the bar's own name is a placeholder that
   * matches nothing in the data.
   */
  members: string[];
}

/** Cap a distribution to the top N slices, folding the rest into a gray "Other". */
export function foldTopN<T extends { plays: number }>(
  items: T[],
  n: number,
  label: (t: T) => string,
): FoldedSlice[] {
  const sorted = [...items].sort((a, b) => b.plays - a.plays);
  const top: FoldedSlice[] = sorted
    .slice(0, n)
    .map((t, i) => ({ name: label(t), plays: t.plays, color: seriesColor(i), members: [label(t)] }));
  const restItems = sorted.slice(n);
  const rest = restItems.reduce((s, t) => s + t.plays, 0);
  if (rest > 0) {
    top.push({ name: 'Other', plays: rest, color: OTHER_COLOR, members: restItems.map(label) });
  }
  return top;
}
