/**
 * Lightweight fuzzy matching for the command palette. `fuzzyScore` returns a
 * relevance score (higher = better) when `query` is a subsequence of `text`, or
 * `null` when it isn't — case-insensitive. Substrings beat scattered subsequences;
 * prefix and word-boundary matches, consecutive runs, and concise targets all score
 * higher. Not a full ranker (no typo tolerance), but enough to make "dup", "rls scr",
 * or "sub sync" find the right page.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const s = text.toLowerCase();

  // Fast path: a contiguous substring is the strongest signal.
  const idx = s.indexOf(q);
  if (idx !== -1) {
    let score = 120 - Math.min(idx, 40);
    if (idx === 0) score += 60; // prefix
    else if (isBoundary(s[idx - 1])) score += 30; // word start
    score += Math.max(0, 20 - (s.length - q.length)); // conciseness
    return score;
  }

  // Subsequence: every query char appears in order.
  let ti = 0;
  let qi = 0;
  let score = 0;
  let prev = -2;
  while (ti < s.length && qi < q.length) {
    if (s[ti] === q[qi]) {
      const consecutive = ti === prev + 1;
      score += consecutive ? 6 : 1;
      if (ti === 0 || isBoundary(s[ti - 1])) score += 5; // word start
      prev = ti;
      qi += 1;
    }
    ti += 1;
  }
  if (qi < q.length) return null; // ran out before matching all of the query
  score += Math.max(0, 15 - Math.floor((s.length - q.length) / 2));
  return score;
}

/** Whether `query` fuzzy-matches `text` at all. */
export function fuzzyMatch(query: string, text: string): boolean {
  return fuzzyScore(query, text) !== null;
}

/** The best score across several candidate fields (label, group, keywords…). */
export function fuzzyBest(query: string, ...texts: (string | undefined)[]): number | null {
  let best: number | null = null;
  for (const text of texts) {
    if (text == null) continue;
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

function isBoundary(ch: string): boolean {
  return ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.';
}
