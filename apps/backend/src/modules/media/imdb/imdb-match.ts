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
