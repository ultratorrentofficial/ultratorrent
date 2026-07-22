import { languageNameToCode } from '../../../common/languages';

/**
 * Map a language name (any case) to its ISO-639-1 code, or 'und'. Pure.
 *
 * For the scraping providers whose HTML gives a language name ("English",
 * "Brazilian Portuguese") rather than a code. The name table lives in
 * `common/languages` alongside the code aliases, so a language added for one
 * provider is understood by the renamer and the cleanup keep-list too.
 */
export function langNameToCode(name: string): string {
  return languageNameToCode(name);
}
