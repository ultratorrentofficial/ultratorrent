/**
 * Pure title-matching helpers for the IMDb dataset search. Side-effect free and
 * unit-testable. Confidence is a 0..1 score combining title similarity, year
 * agreement, and title-type agreement.
 */

/** IMDb titleType → the media manager's coarse `type` filter. */
export type ImdbTitleKind = 'movie' | 'tv' | 'episode' | 'any';

/** Lowercase, strip punctuation/diacritics, collapse whitespace. */
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Levenshtein distance between two strings (bounded, iterative). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Normalized string similarity in 0..1 (1 = identical after normalization). */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : Math.max(0, 1 - dist / maxLen);
}

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13,
};

/**
 * A title split into its base and its trailing sequel number.
 *
 * "Ultimate Avengers 2" → { base: 'ultimate avengers', num: 2 }; "Rocky V" →
 * { base: 'rocky', num: 5 }; "Blade Runner 2049" → { base: 'blade runner', num: 2049 };
 * "Inception" → { base: 'inception', num: null }. Handles a trailing arabic integer
 * or roman numeral so "Rocky 5" and "Rocky V" resolve to the same number.
 */
function sequelMarker(normalized: string): { base: string; num: number | null } {
  const tokens = normalized.split(' ');
  if (tokens.length < 2) return { base: normalized, num: null };
  const last = tokens[tokens.length - 1];
  const num = /^\d{1,4}$/.test(last) ? Number(last) : (ROMAN[last] ?? null);
  if (num == null) return { base: normalized, num: null };
  const rest = tokens.slice(0, -1);
  // An ordinal qualifier belongs to the number, not the base title: "… Streaming
  // Wars Part 2" is entry 2 of "… Streaming Wars", so dropping the qualifier is
  // what lets it conflict with the unnumbered first film. Without this the bases
  // ("… wars part" vs "… wars") differ and the gate never fires.
  if (rest.length > 1 && /^(?:part|pt|chapter|ch|vol|volume)$/.test(rest[rest.length - 1])) {
    rest.pop();
  }
  return { base: rest.join(' '), num };
}

/**
 * True when two titles are the SAME franchise base but a DIFFERENT sequel number —
 * a film and its sequel, which title similarity + year alone confuse. Observed live:
 * "Ultimate Avengers" (2006) and "Ultimate Avengers 2" (2006) — same year, titles
 * differing only by "2" — were matched to one id.
 *
 * It never rejects a correct match: the same film always carries the same trailing
 * number, so its two spellings resolve to an equal `num` (that is also why arabic and
 * roman are unified — "Rocky 5" and "Rocky V" are the same film, not a conflict). It
 * fires only when the base titles match and the numbers genuinely differ.
 */
export function titlesAreSequelVariants(a: string, b: string): boolean {
  const sa = sequelMarker(normalizeTitle(a));
  const sb = sequelMarker(normalizeTitle(b));
  if (sa.num == null && sb.num == null) return false;
  return sa.base === sb.base && sa.num !== sb.num;
}

/** True when an IMDb titleType is one of the TV episode/series kinds. */
export function isTvType(titleType: string): boolean {
  return (
    titleType === 'tvSeries' ||
    titleType === 'tvMiniSeries' ||
    titleType === 'tvEpisode' ||
    titleType === 'tvSpecial'
  );
}

/** Does an IMDb titleType satisfy a coarse `kind` filter? */
export function titleTypeMatchesKind(
  titleType: string,
  kind: ImdbTitleKind,
): boolean {
  switch (kind) {
    case 'movie':
      return titleType === 'movie' || titleType === 'tvMovie' || titleType === 'short';
    case 'tv':
      return titleType === 'tvSeries' || titleType === 'tvMiniSeries';
    case 'episode':
      return titleType === 'tvEpisode';
    case 'any':
    default:
      return true;
  }
}

export interface CandidateTitle {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  startYear: number | null;
  /** Any AKA titles known for this candidate (optional, boosts recall). */
  akas?: string[];
}

export interface MatchQuery {
  title: string;
  year?: number | null;
  type?: ImdbTitleKind;
}

/**
 * Confidence 0..1 that `candidate` is the title described by `query`. The best
 * of primary/original/AKA title similarity dominates; a matching year and a
 * matching type each add a small bonus, a wrong year applies a small penalty.
 */
export function scoreTitleMatch(query: MatchQuery, candidate: CandidateTitle): number {
  const names = [
    candidate.primaryTitle,
    candidate.originalTitle,
    ...(candidate.akas ?? []),
  ].filter(Boolean);
  let best = 0;
  for (const name of names) {
    best = Math.max(best, titleSimilarity(query.title, name));
    if (best === 1) break;
  }

  let score = best * 0.8; // title similarity is the dominant signal

  // Year agreement.
  if (query.year != null && candidate.startYear != null) {
    const diff = Math.abs(query.year - candidate.startYear);
    if (diff === 0) score += 0.15;
    else if (diff === 1) score += 0.05;
    else score -= 0.1;
  }

  // Type agreement.
  const kind = query.type ?? 'any';
  if (kind !== 'any' && titleTypeMatchesKind(candidate.titleType, kind)) {
    score += 0.05;
  }

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}
