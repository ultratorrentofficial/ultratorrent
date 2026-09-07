/**
 * Pure helpers for the acquisition ladder editor.
 *
 * Separated from the component so the parts that are easy to get quietly wrong —
 * unit conversion and reordering — can be tested without rendering anything.
 */

/**
 * The quality keys the match engine actually reads.
 *
 * Mirrors `QUALITY_KEYS` in `acquisition-template.service.ts`. `hdr` and `audio`
 * are deliberately absent from both: the engine does not consume them, so
 * offering them would give an operator a preference that looks configured and
 * silently does nothing. Dolby Vision and Atmos go in required terms.
 */
export const QUALITY_FIELDS = ['resolution', 'source', 'codec', 'quality'] as const;
export type QualityField = (typeof QUALITY_FIELDS)[number];

/** Suggestions only — the field is free text, because release vocabulary moves. */
export const QUALITY_SUGGESTIONS: Record<QualityField, string[]> = {
  resolution: ['2160p', '1080p', '720p', '480p'],
  source: ['WEB-DL', 'WEBRip', 'BluRay', 'HDTV', 'Remux'],
  codec: ['x265', 'x264', 'HEVC', 'AV1'],
  quality: ['REPACK', 'PROPER'],
};

/** The match types `match-engine.ts` implements. */
export const MATCH_TYPES = [
  'smart_episode_match',
  'smart_movie_match',
  'contains_text',
  'exact_text',
  'wildcard',
  'regex',
  'fuzzy_match',
] as const;

/** Only these two carry a pattern; the others match on the parsed release. */
export const PATTERN_MATCH_TYPES = new Set(['regex', 'wildcard', 'exact_text', 'contains_text']);

const GB = 1024 ** 3;

/**
 * Gigabytes in, bytes out.
 *
 * The API stores bytes, which is correct and unusable by hand — nobody types
 * 8589934592. An empty or unparseable box means "no limit", not zero: a zero
 * maximum would reject every release, and a zero minimum is the same as none.
 */
export function toBytes(gb: string | number | null | undefined): number | undefined {
  if (gb === '' || gb === null || gb === undefined) return undefined;
  const n = typeof gb === 'number' ? gb : Number(gb);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * GB);
}

/** Bytes back to a short GB string for the input, or '' when unset. */
export function fromBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / GB;
  // Two decimals is enough to round-trip a value somebody typed, without
  // rendering 3.9999999999 for something entered as 4.
  return String(Math.round(gb * 100) / 100);
}

/**
 * Move a rung, returning a new array.
 *
 * Out-of-range moves are a no-op rather than an error: the buttons at the ends of
 * the ladder are disabled, and a component that threw when one slipped through
 * would take the page with it over a cosmetic mistake.
 */
export function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Position IS priority.
 *
 * The ladder is read top to bottom, so exposing a priority NUMBER as well would
 * be two sources of truth that can disagree. Order is renumbered from zero on
 * save, which also tidies any gaps an older template left behind.
 */
export function renumber<T extends { priorityOrder?: number }>(items: T[]): T[] {
  return items.map((c, i) => ({ ...c, priorityOrder: i }));
}

/** Comma-separated text ⇄ a term list, trimmed and de-duplicated. */
export function parseTerms(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];
}
export function joinTerms(terms: string[] | undefined): string {
  return (terms ?? []).join(', ');
}

/** Drop empty quality values so `{ resolution: '' }` is never sent as a rule. */
export function cleanQuality(rules: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rules).filter(([, v]) => v && v.trim()));
}
