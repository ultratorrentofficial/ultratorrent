/**
 * A resolution label for an episode row.
 *
 * `MediaFile.resolution` holds the token parsed from the FILENAME, and the
 * renamer strips exactly those tokens — so on a renamed library it is almost
 * always null. Measured `width`/`height` are not: on the live TV library
 * `resolution` is set on 1,590 of 25,595 files while `width` is measured on
 * 24,786. Reading only the string meant 94% of episodes showed no resolution
 * at all while the number was sitting in the next column.
 *
 * Thresholds mirror the backend's `classifyResolution`, so a row and a cleanup
 * policy describe the same file the same way. Deliberately a *label*, not a
 * measurement: it answers "what tier is this", which is the question a row is
 * being scanned for.
 */
export function resolutionLabel(
  resolution?: string | null,
  width?: number | null,
  height?: number | null,
): string | null {
  // A filename token that survived is what the operator's other tools show.
  if (resolution?.trim()) return resolution.trim();

  const w = width ?? 0;
  const h = height ?? 0;
  if (w <= 0 && h <= 0) return null;

  if (h >= 3500 || w >= 6500) return '4320p';
  if (h >= 1700 || w >= 3200) return '2160p';
  if (h >= 1300 || w >= 2400) return '1440p';
  if (h >= 850 || w >= 1800) return '1080p';
  if (h >= 620 || w >= 1200) return '720p';
  if (h >= 520 || w >= 900) return '576p';
  if (h >= 380 || w >= 700) return '480p';
  return 'SD';
}
