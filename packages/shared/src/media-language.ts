/**
 * One canonical name for a language, whatever a provider calls it.
 *
 * Providers do not agree, and both forms end up in the same catalogue:
 *
 *   TMDB   -> ISO 639-1 codes:  `en`, `de`, `ja`
 *   TVmaze -> English names:    `English`, `German`, `Japanese`
 *
 * Comparing those raw means a template that says "English" silently rejects
 * every TMDB-sourced title — measured on a live catalogue: 195 rows stored
 * `English` and 170 stored `en`, and the second group was unreachable. The
 * symptom is the worst kind: a brand-new English-language show sits in the
 * inbox looking like nothing ever looked at it.
 *
 * This table already existed inside the TVmaze provider, where it was used to
 * filter what that one provider returned. It belongs here, so the policy that
 * compares a stored value against an operator's template uses the same answer.
 */

const ALIASES: Record<string, string> = {
  en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian',
  pt: 'portuguese', ja: 'japanese', ko: 'korean', zh: 'chinese', ru: 'russian',
  nl: 'dutch', sv: 'swedish', da: 'danish', no: 'norwegian', fi: 'finnish',
  pl: 'polish', tr: 'turkish', he: 'hebrew', ar: 'arabic', hi: 'hindi',
  cs: 'czech', el: 'greek', hu: 'hungarian', id: 'indonesian', ms: 'malay',
  ro: 'romanian', th: 'thai', uk: 'ukrainian', vi: 'vietnamese', fa: 'persian',
  bn: 'bengali', ta: 'tamil', te: 'telugu', ml: 'malayalam', mr: 'marathi',
  tl: 'tagalog', sr: 'serbian', hr: 'croatian', bg: 'bulgarian', sk: 'slovak',
  et: 'estonian', lv: 'latvian', lt: 'lithuanian', is: 'icelandic', ca: 'catalan',
};

/**
 * The comparable form of a language value.
 *
 * Lowercased, with an ISO code expanded to its English name. An unknown value is
 * lowercased and returned as-is rather than dropped: a language this table has
 * never heard of should still match itself, and a template naming it should
 * still work.
 */
export function canonicalLanguage(value: string | null | undefined): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  return ALIASES[raw] ?? raw;
}

/** Does a stored language satisfy a template's list? An empty list allows all. */
export function languageAllowed(
  language: string | null | undefined,
  allowed: string[] | null | undefined,
): boolean {
  const want = (allowed ?? []).map(canonicalLanguage).filter(Boolean);
  if (!want.length) return true;
  const have = canonicalLanguage(language);
  // An unknown language cannot satisfy a list that names specific ones —
  // treating "we do not know" as a match would let the filter through anything
  // whose provider omitted the field.
  return have ? want.includes(have) : false;
}
