/**
 * Pure helpers for the missing-subtitle scan. Kept separate from the service so
 * the "what's missing?" logic is trivially unit-testable.
 */

/** Normalize a language tag to its base ISO-639-1-ish form (drops region + case). */
export function baseLang(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * Which of the `wanted` languages are not already present. Compares on the base
 * language (so a present `en` satisfies a wanted `en-US`, and vice versa), and
 * de-duplicates. `und` (undetermined) present tags never satisfy anything. Pure.
 */
export function missingLanguages(present: string[], wanted: string[]): string[] {
  const have = new Set(present.map(baseLang).filter((l) => l && l !== 'und'));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of wanted) {
    const b = baseLang(w);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    if (!have.has(b)) out.push(w.trim());
  }
  return out;
}
