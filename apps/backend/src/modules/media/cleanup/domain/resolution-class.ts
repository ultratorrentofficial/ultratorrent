/**
 * Normalized resolution classes for cleanup policies.
 *
 * Why this exists alongside `resolutionFromHeight` (media-probe.service.ts): that
 * function produces the label STORED on `MediaFile.resolution`, which five other
 * ladders and the duplicate ranker already consume. Changing its output would
 * re-label ~29k existing rows and shift duplicate recommendations, so it is left
 * exactly as it is. This module adds what a policy needs and that function cannot
 * give: the missing tiers (576p / 1440p / 4320p) and — critically — a total
 * ORDER, because `resolutionClass < 1080p` is a comparison and a string label is
 * not comparable.
 *
 * It classifies from MEASURED width/height only. A filename-derived label is a
 * guess (the renamer strips the token, and a rescan used to overwrite a real
 * measurement with one), so a policy that deletes on resolution reads pixels or
 * it reads `unknown` and the candidate is excluded as unmeasured.
 *
 * Width is a first-class signal, not a fallback: a 2.39:1 scope encode of a 1080p
 * master is 1920x800. Classifying that on height alone calls it 720p and makes it
 * a deletion candidate under "below 1080p" — the exact mistake this guards.
 */

export const RESOLUTION_CLASSES = [
  'sd',
  '480p',
  '576p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
  '4320p',
] as const;

export type ResolutionClass = (typeof RESOLUTION_CLASSES)[number] | 'unknown';

/** Ordinal for `lt`/`lte`/`gt`/`gte`. `unknown` is deliberately NOT comparable. */
const ORDINALS: Record<string, number> = Object.fromEntries(
  RESOLUTION_CLASSES.map((c, i) => [c, i]),
);

/**
 * Classify a measured frame. Bands key off the LOWER bound of each tier so a
 * cropped/letterboxed frame still reports the tier it was mastered at, and each
 * tier also accepts its characteristic width so scope framing cannot demote it.
 *
 * Thresholds are consistent with `resolutionFromHeight` for the tiers they share,
 * so the two never contradict each other on the same file.
 */
export function classifyResolution(width?: number | null, height?: number | null): ResolutionClass {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w <= 0 && h <= 0) return 'unknown';

  if (h >= 3500 || w >= 6500) return '4320p';
  if (h >= 1700 || w >= 3200) return '2160p';
  if (h >= 1300 || w >= 2400) return '1440p';
  if (h >= 850 || w >= 1800) return '1080p';
  if (h >= 620 || w >= 1200) return '720p';
  // 576p (PAL) sits just above 480p (NTSC); both are "DVD-ish" but distinct.
  if (h >= 520 || w >= 900) return '576p';
  if (h >= 380 || w >= 700) return '480p';
  return 'sd';
}

/** Numeric rank, or null when the class is not comparable. */
export function resolutionOrdinal(cls: ResolutionClass): number | null {
  return cls === 'unknown' ? null : (ORDINALS[cls] ?? null);
}

/**
 * Compare two classes. Returns null when either side is `unknown` — an unmeasured
 * file must not satisfy OR fail a resolution comparison; it is excluded upstream.
 */
export function compareResolution(a: ResolutionClass, b: ResolutionClass): number | null {
  const x = resolutionOrdinal(a);
  const y = resolutionOrdinal(b);
  if (x == null || y == null) return null;
  return x - y;
}

/** True when `cls` is a known class at or above `floor`. */
export function isAtLeast(cls: ResolutionClass, floor: ResolutionClass): boolean {
  const cmp = compareResolution(cls, floor);
  return cmp != null && cmp >= 0;
}
