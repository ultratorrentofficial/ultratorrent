/**
 * Classifies a scene/p2p release title as a SEASON pack, a COMPLETE-SERIES pack, or
 * neither (a single or multi-episode file). Used by pack-aware backfill to tell a
 * pack release apart from an ordinary episode so it can be grabbed and fanned out by
 * intake.
 *
 * Deliberately separate from `rss/torrent-name-parser.ts` (which RSS depends on and
 * must not change): this only answers the pack question, and is pure + unit-tested.
 */

export type PackType = 'season' | 'series';

export interface PackClassification {
  /** null when the release is not a pack (a single/multi-episode file). */
  type: PackType | null;
  /** The season a `season` pack covers; the FIRST season a `series` range covers. */
  season: number | null;
  /** The last season a `series` range covers (S01-S06 → 6); null for open/"complete". */
  seasonEnd: number | null;
}

const NONE: PackClassification = { type: null, season: null, seasonEnd: null };

/** Normalise scene separators (dots/underscores) to spaces, like the parser does. */
function normalizeSeparators(raw: string): string {
  return raw.replace(/\.(mkv|mp4|avi|ts|m2ts|torrent)$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyPack(rawTitle: string | null | undefined): PackClassification {
  if (!rawTitle) return NONE;
  const t = normalizeSeparators(rawTitle);

  // An explicit episode marker means this is a single (or multi-) episode FILE, never
  // a pack — even inside a title that also mentions a season.
  if (/\bs\d{1,2}\s*e\d{1,3}\b/i.test(t)) return NONE; // S01E01
  if (/\b\d{1,2}x\d{1,3}\b/i.test(t)) return NONE; // 1x01
  if (/\bseason\s*\d{1,2}\s*episode\s*\d{1,3}\b/i.test(t)) return NONE;

  // A season RANGE (S01-S06, Seasons 1-6) is a complete/multi-season pack.
  let m: RegExpExecArray | null;
  if ((m = /\bs(\d{1,2})\s*[-–]\s*s?(\d{1,2})\b/i.exec(t)) || (m = /\bseasons?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i.exec(t))) {
    const a = +m[1];
    const b = +m[2];
    return { type: 'series', season: Math.min(a, b), seasonEnd: Math.max(a, b) };
  }

  // Several discrete season markers ("S01 S02 S03") → a multi-season pack.
  const marks = [
    ...[...t.matchAll(/\bs(\d{1,2})\b(?!\s*e\d)/gi)].map((x) => +x[1]),
    ...[...t.matchAll(/\bseason\s*(\d{1,2})\b/gi)].map((x) => +x[1]),
  ];
  const seasons = [...new Set(marks)].sort((x, y) => x - y);
  if (seasons.length >= 2) {
    return { type: 'series', season: seasons[0], seasonEnd: seasons[seasons.length - 1] };
  }

  // "Complete Series" / "The Complete Series" / a bare "Complete" with no single
  // season → a full-series pack. ("Complete Season 3" keeps its season below.)
  if (/\bcomplete\b/i.test(t) && (/\bseries\b/i.test(t) || seasons.length === 0)) {
    return { type: 'series', season: null, seasonEnd: null };
  }

  // A lone season marker (S03 / Season 3 / Complete Season 3) → a season pack.
  if (seasons.length === 1) {
    return { type: 'season', season: seasons[0], seasonEnd: null };
  }

  return NONE;
}

/**
 * The show-title portion of a pack release — everything before the first season /
 * range / "complete" marker. `showTitleMatch` bounds a title at an EPISODE marker or
 * a format token, so a season-only pack ("Vikings S03 1080p") would otherwise fold
 * "S03" into the title and never match; feed it this region instead.
 */
export function packTitleRegion(rawTitle: string | null | undefined): string {
  if (!rawTitle) return '';
  const t = normalizeSeparators(rawTitle);
  // Cut at the first pack marker, swallowing a "The " that belongs to "The Complete
  // Series" (so it does not fold into the show title).
  const m = /\b(?:the\s+)?(?:complete\b|seasons?\b|s\d{1,2}\b)/i.exec(t);
  return (m ? t.slice(0, m.index) : t).trim();
}

/** Does a classified series pack cover every season the caller still needs? */
export function seriesPackCovers(pack: PackClassification, neededSeasons: number[]): boolean {
  if (pack.type !== 'series') return false;
  // An open "complete series" (no explicit range) is taken to cover everything.
  if (pack.season == null || pack.seasonEnd == null) return true;
  return neededSeasons.every((s) => s >= (pack.season as number) && s <= (pack.seasonEnd as number));
}
