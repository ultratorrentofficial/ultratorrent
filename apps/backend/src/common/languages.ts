/**
 * The one language table.
 *
 * Subtitle language codes were previously defined FIVE times — in the renamer, the
 * sidecar scanner, the local-repository provider and the scraper name map — and the
 * copies disagreed. The renamer knew 18 languages, the scraper name map 44, and the
 * local-repository provider was missing the three-letter forms of six languages it
 * already accepted in two-letter form.
 *
 * That divergence deleted files. The cleanup pass keeps a subtitle only when its
 * normalised code is in the operator's keep-list, and normalisation fell back to
 * "lower-case it and hope". A library holding `.heb.srt` / `.hun.srt` against a
 * keep-list written the way the field documents it ("ISO-639 codes") — `he`, `hu` —
 * matched nothing, so those subtitles were deleted while `.eng.srt` survived purely
 * because `eng` happened to be one of the 18 aliases. Whether a file lived depended
 * on which spelling the operator typed.
 *
 * One row per language: its ISO-639-1 code, its English name, every alias that means
 * the same language (ISO-639-2/B and /T both — `ger`/`deu`, `fre`/`fra`, `chi`/`zho`
 * — plus legacy and provider-specific spellings), and any extra names a scraper
 * renders instead of a code.
 */

interface LanguageEntry {
  /** ISO-639-1, the canonical form everything normalises to. */
  code: string;
  /** English display name; also matched as a name. */
  name: string;
  /** Alternate CODES (639-2/B, 639-2/T, legacy, provider-specific). */
  codes?: string[];
  /** Alternate NAMES a provider might render instead of a code. */
  names?: string[];
}

const LANGUAGES: LanguageEntry[] = [
  { code: 'en', name: 'English', codes: ['eng'] },
  { code: 'es', name: 'Spanish', codes: ['spa'], names: ['castilian', 'spanish (latin america)', 'latin american spanish'] },
  { code: 'fr', name: 'French', codes: ['fre', 'fra'] },
  { code: 'de', name: 'German', codes: ['ger', 'deu'] },
  { code: 'it', name: 'Italian', codes: ['ita'] },
  { code: 'pt', name: 'Portuguese', codes: ['por', 'pob', 'pt-br'], names: ['brazilian portuguese', 'portuguese (brazil)'] },
  { code: 'nl', name: 'Dutch', codes: ['dut', 'nld'], names: ['flemish'] },
  { code: 'ja', name: 'Japanese', codes: ['jpn'] },
  { code: 'ko', name: 'Korean', codes: ['kor'] },
  { code: 'zh', name: 'Chinese', codes: ['chi', 'zho'], names: ['chinese bg code', 'big 5 code', 'mandarin', 'cantonese', 'chinese simplified', 'chinese traditional'] },
  { code: 'ru', name: 'Russian', codes: ['rus'] },
  { code: 'ar', name: 'Arabic', codes: ['ara'] },
  { code: 'pl', name: 'Polish', codes: ['pol'] },
  { code: 'sv', name: 'Swedish', codes: ['swe'] },
  { code: 'da', name: 'Danish', codes: ['dan'] },
  { code: 'no', name: 'Norwegian', codes: ['nor', 'nob', 'nno'], names: ['norwegian bokmal', 'norwegian nynorsk'] },
  { code: 'fi', name: 'Finnish', codes: ['fin'] },
  { code: 'hi', name: 'Hindi', codes: ['hin'] },
  { code: 'tr', name: 'Turkish', codes: ['tur'] },
  { code: 'el', name: 'Greek', codes: ['gre', 'ell'] },
  { code: 'he', name: 'Hebrew', codes: ['heb', 'iw'] },
  { code: 'hu', name: 'Hungarian', codes: ['hun'] },
  { code: 'cs', name: 'Czech', codes: ['cze', 'ces'] },
  { code: 'sk', name: 'Slovak', codes: ['slo', 'slk'] },
  { code: 'ro', name: 'Romanian', codes: ['rum', 'ron'] },
  { code: 'bg', name: 'Bulgarian', codes: ['bul'] },
  { code: 'hr', name: 'Croatian', codes: ['hrv', 'scr'] },
  { code: 'sr', name: 'Serbian', codes: ['srp', 'scc'] },
  { code: 'sl', name: 'Slovenian', codes: ['slv'] },
  { code: 'bs', name: 'Bosnian', codes: ['bos'] },
  { code: 'mk', name: 'Macedonian', codes: ['mac', 'mkd'] },
  { code: 'sq', name: 'Albanian', codes: ['alb', 'sqi'] },
  { code: 'th', name: 'Thai', codes: ['tha'] },
  { code: 'id', name: 'Indonesian', codes: ['ind', 'in'] },
  { code: 'ms', name: 'Malay', codes: ['may', 'msa'] },
  { code: 'vi', name: 'Vietnamese', codes: ['vie'] },
  { code: 'tl', name: 'Tagalog', codes: ['tgl', 'fil'], names: ['filipino'] },
  { code: 'ta', name: 'Tamil', codes: ['tam'] },
  { code: 'te', name: 'Telugu', codes: ['tel'] },
  { code: 'ml', name: 'Malayalam', codes: ['mal'] },
  { code: 'kn', name: 'Kannada', codes: ['kan'] },
  { code: 'mr', name: 'Marathi', codes: ['mar'] },
  { code: 'pa', name: 'Punjabi', codes: ['pan'] },
  { code: 'bn', name: 'Bengali', codes: ['ben'] },
  { code: 'si', name: 'Sinhala', codes: ['sin'], names: ['sinhalese'] },
  { code: 'ne', name: 'Nepali', codes: ['nep'] },
  { code: 'ur', name: 'Urdu', codes: ['urd'] },
  { code: 'fa', name: 'Persian', codes: ['per', 'fas'], names: ['farsi', 'farsi/persian'] },
  { code: 'uk', name: 'Ukrainian', codes: ['ukr'] },
  { code: 'be', name: 'Belarusian', codes: ['bel'] },
  { code: 'et', name: 'Estonian', codes: ['est'] },
  { code: 'lv', name: 'Latvian', codes: ['lav'] },
  { code: 'lt', name: 'Lithuanian', codes: ['lit'] },
  { code: 'is', name: 'Icelandic', codes: ['ice', 'isl'] },
  { code: 'ca', name: 'Catalan', codes: ['cat'] },
  { code: 'gl', name: 'Galician', codes: ['glg'] },
  { code: 'eu', name: 'Basque', codes: ['baq', 'eus'] },
  { code: 'ka', name: 'Georgian', codes: ['geo', 'kat'] },
  { code: 'hy', name: 'Armenian', codes: ['arm', 'hye'] },
  { code: 'az', name: 'Azerbaijani', codes: ['aze'] },
  { code: 'kk', name: 'Kazakh', codes: ['kaz'] },
  { code: 'mn', name: 'Mongolian', codes: ['mon'] },
  { code: 'km', name: 'Khmer', codes: ['khm'], names: ['cambodian'] },
  { code: 'lo', name: 'Lao', codes: ['lao'] },
  { code: 'my', name: 'Burmese', codes: ['bur', 'mya'] },
  { code: 'af', name: 'Afrikaans', codes: ['afr'] },
  { code: 'sw', name: 'Swahili', codes: ['swa'] },
  { code: 'ga', name: 'Irish', codes: ['gle'] },
  { code: 'cy', name: 'Welsh', codes: ['wel', 'cym'] },
  { code: 'mt', name: 'Maltese', codes: ['mlt'] },
  { code: 'eo', name: 'Esperanto', codes: ['epo'] },
  { code: 'la', name: 'Latin', codes: ['lat'] },
  { code: 'yi', name: 'Yiddish', codes: ['yid'] },
];

/** The code every alias resolves to: alias (or 639-1 code) → 639-1. */
const CODE_TO_CODE = new Map<string, string>();
/** Language NAME (lower-case, may contain spaces) → 639-1. */
const NAME_TO_CODE = new Map<string, string>();
/** Single-word forms safe to look for among a filename's tokens. */
const TOKEN_TO_CODE = new Map<string, string>();

for (const l of LANGUAGES) {
  CODE_TO_CODE.set(l.code, l.code);
  TOKEN_TO_CODE.set(l.code, l.code);
  for (const alias of l.codes ?? []) {
    CODE_TO_CODE.set(alias, l.code);
    // A hyphenated alias like `pt-br` never survives filename tokenisation.
    if (!alias.includes('-')) TOKEN_TO_CODE.set(alias, l.code);
  }
  for (const name of [l.name.toLowerCase(), ...(l.names ?? [])]) {
    NAME_TO_CODE.set(name, l.code);
    if (!/[\s/()]/.test(name)) TOKEN_TO_CODE.set(name, l.code);
  }
}

/** Every ISO-639-1 code this application understands. */
export const KNOWN_LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

/** The English name for a 639-1 code, or the code itself when unknown. */
export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code.toLowerCase())?.name ?? code;
}

/**
 * Normalise a language code to its ISO-639-1 form.
 *
 * Unknown codes pass through lower-cased rather than becoming `und`: a keep-list is
 * compared against this, and turning an unrecognised code into a single sentinel
 * would make every unknown language look like every other one.
 */
export function normalizeLanguageCode(code: string): string {
  const c = code.trim().toLowerCase();
  return CODE_TO_CODE.get(c) ?? c;
}

/** Map a language NAME (any case) to its 639-1 code, or `und`. */
export function languageNameToCode(name: string): string {
  return NAME_TO_CODE.get(name.trim().toLowerCase()) ?? 'und';
}

/** A single filename token → 639-1 code, or null when it names no language. */
export function languageFromToken(token: string): string | null {
  return TOKEN_TO_CODE.get(token.trim().toLowerCase()) ?? null;
}

export interface SubtitleTags {
  /** 639-1 code, or `und` when the filename names no language. */
  language: string;
  forced: boolean;
  sdh: boolean;
}

/**
 * Read the language and flags off a subtitle filename's TRAILING tokens.
 *
 * Scanning every token (what this used to do, despite the comment saying otherwise)
 * reads a language out of the title itself: "No.Country.For.Old.Men.srt" announced
 * Norwegian, and the bigger the table the more titles collide — `is`, `it`, `id`,
 * `no`, `la` and `my` are all ordinary English words as well as language codes.
 *
 * A language tag sits at the END, after the title, so the scan runs right-to-left and
 * stops at the first token that is neither a language nor a flag. The rightmost
 * language in that trailing run wins, which is what a `Movie.iTA.ENG.srt` dual-tagged
 * release means. `hi` stays the SDH ("hearing impaired") flag rather than Hindi — it
 * is overwhelmingly the flag in a subtitle filename.
 */
export function subtitleTagsFromTokens(tokens: string[]): SubtitleTags {
  let language = 'und';
  let forced = false;
  let sdh = false;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toLowerCase();
    if (!t) continue;
    if (t === 'forced') { forced = true; continue; }
    if (t === 'sdh' || t === 'hi' || t === 'cc') { sdh = true; continue; }
    const code = languageFromToken(t);
    if (code) {
      if (language === 'und') language = code;
      continue;
    }
    break; // a real title word — the trailing tag run ends here
  }
  return { language, forced, sdh };
}

/** Split a subtitle filename (extension already dropped) into comparable tokens. */
export function subtitleTagsFromName(baseName: string): SubtitleTags {
  return subtitleTagsFromTokens(baseName.split(/[.\s_-]+/));
}
