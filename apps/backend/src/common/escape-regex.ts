/**
 * Turn a literal string into a pattern that matches exactly itself.
 *
 * Used where a value that is TEXT ends up somewhere a regular expression is
 * expected. The usual cause is a fallback: a rule wants a pattern, none was
 * given, and the show's title is substituted — at which point `S.W.A.T.` stops
 * meaning what it says and starts matching `SXWXAXTX`.
 *
 * Deliberately one small function with one job. The escape set is every
 * character with special meaning in a JavaScript regular expression, escaped in
 * a single pass — not a chain of `replace` calls, which is how a backslash ends
 * up escaped twice and the pattern stops matching anything at all.
 */
export function escapeRegex(input: string): string {
  return String(input ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
