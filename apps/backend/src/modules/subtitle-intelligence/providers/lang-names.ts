/**
 * Language NAME → ISO-639-1 code, for the scraping providers whose HTML gives a
 * language name ("English", "Brazilian Portuguese") rather than a code. Pure.
 */
const NAME_TO_CODE: Record<string, string> = {
  english: 'en', arabic: 'ar', spanish: 'es', 'spanish (latin america)': 'es',
  'brazilian portuguese': 'pt', portuguese: 'pt', french: 'fr', german: 'de',
  italian: 'it', dutch: 'nl', japanese: 'ja', korean: 'ko', chinese: 'zh',
  'chinese bg code': 'zh', 'big 5 code': 'zh', russian: 'ru', polish: 'pl',
  swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', turkish: 'tr',
  greek: 'el', hebrew: 'he', hungarian: 'hu', czech: 'cs', slovak: 'sk',
  romanian: 'ro', bulgarian: 'bg', croatian: 'hr', serbian: 'sr', slovenian: 'sl',
  thai: 'th', indonesian: 'id', malay: 'ms', vietnamese: 'vi', hindi: 'hi',
  tamil: 'ta', telugu: 'te', bengali: 'bn', urdu: 'ur', farsi: 'fa',
  'farsi/persian': 'fa', persian: 'fa', ukrainian: 'uk', catalan: 'ca',
  estonian: 'et', latvian: 'lv', lithuanian: 'lt', icelandic: 'is',
};

/** Map a language name (any case) to its ISO-639-1 code, or 'und'. Pure. */
export function langNameToCode(name: string): string {
  return NAME_TO_CODE[name.trim().toLowerCase()] ?? 'und';
}
