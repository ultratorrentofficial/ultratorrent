import {
  KNOWN_LANGUAGE_CODES,
  languageFromToken,
  languageName,
  languageNameToCode,
  normalizeLanguageCode,
  subtitleTagsFromName,
} from './languages';

describe('normalizeLanguageCode', () => {
  it('maps ISO-639-2 to 639-1', () => {
    expect(normalizeLanguageCode('eng')).toBe('en');
    expect(normalizeLanguageCode('SPA')).toBe('es');
    expect(normalizeLanguageCode(' Por ')).toBe('pt');
  });

  it('accepts both the bibliographic and terminological 639-2 forms', () => {
    // A provider may send either; they name the same language.
    for (const [b, t, code] of [
      ['ger', 'deu', 'de'], ['fre', 'fra', 'fr'], ['chi', 'zho', 'zh'],
      ['dut', 'nld', 'nl'], ['gre', 'ell', 'el'], ['per', 'fas', 'fa'],
      ['cze', 'ces', 'cs'], ['slo', 'slk', 'sk'], ['rum', 'ron', 'ro'],
      ['ice', 'isl', 'is'], ['may', 'msa', 'ms'], ['wel', 'cym', 'cy'],
    ]) {
      expect(normalizeLanguageCode(b)).toBe(code);
      expect(normalizeLanguageCode(t)).toBe(code);
    }
  });

  it('resolves the codes whose absence deleted subtitles', () => {
    // Live on a Lucifer library: .heb/.hun/.ind sidecars against a he/hu/id
    // keep-list matched nothing, so the cleanup pass deleted them.
    expect(normalizeLanguageCode('heb')).toBe('he');
    expect(normalizeLanguageCode('hun')).toBe('hu');
    expect(normalizeLanguageCode('ind')).toBe('id');
    // And the six the local-repository provider knew in one spelling only.
    expect(normalizeLanguageCode('swe')).toBe('sv');
    expect(normalizeLanguageCode('dan')).toBe('da');
    expect(normalizeLanguageCode('fin')).toBe('fi');
    expect(normalizeLanguageCode('pol')).toBe('pl');
    expect(normalizeLanguageCode('nor')).toBe('no');
    expect(normalizeLanguageCode('hin')).toBe('hi');
  });

  it('is idempotent — a 639-1 code normalises to itself', () => {
    for (const code of KNOWN_LANGUAGE_CODES) {
      expect(normalizeLanguageCode(code)).toBe(code);
      expect(normalizeLanguageCode(normalizeLanguageCode(code))).toBe(code);
    }
  });

  it('passes an unknown code through instead of collapsing it to und', () => {
    // A keep-list is compared against this. Mapping every unknown code to one
    // sentinel would make unrelated languages compare equal.
    expect(normalizeLanguageCode('xx')).toBe('xx');
    expect(normalizeLanguageCode('KLINGON')).toBe('klingon');
  });
});

describe('languageNameToCode', () => {
  it('maps names, including the multi-word ones providers render', () => {
    expect(languageNameToCode('English')).toBe('en');
    expect(languageNameToCode('arabic')).toBe('ar');
    expect(languageNameToCode('Brazilian Portuguese')).toBe('pt');
    expect(languageNameToCode('Farsi/Persian')).toBe('fa');
    expect(languageNameToCode('Chinese BG code')).toBe('zh');
  });

  it('returns und for a name it does not know', () => {
    expect(languageNameToCode('Klingon')).toBe('und');
  });

  it('every known code has a display name', () => {
    for (const code of KNOWN_LANGUAGE_CODES) {
      expect(languageName(code)).not.toBe(code);
      expect(languageNameToCode(languageName(code))).toBe(code);
    }
  });
});

describe('languageFromToken', () => {
  it('accepts single-word codes and names but never a multi-word name', () => {
    expect(languageFromToken('eng')).toBe('en');
    expect(languageFromToken('English')).toBe('en');
    expect(languageFromToken('brazilian portuguese')).toBeNull();
    expect(languageFromToken('pt-br')).toBeNull(); // never survives tokenisation
  });
});

describe('subtitleTagsFromName', () => {
  it('reads the language and flags off the trailing tokens', () => {
    expect(subtitleTagsFromName('Movie.en')).toEqual({ language: 'en', forced: false, sdh: false });
    expect(subtitleTagsFromName('Movie.eng.forced')).toEqual({ language: 'en', forced: true, sdh: false });
    expect(subtitleTagsFromName('Show.S01E01.spa.sdh')).toEqual({ language: 'es', forced: false, sdh: true });
  });

  it('treats a trailing "hi" as the hearing-impaired flag, not Hindi', () => {
    expect(subtitleTagsFromName('Show.fr.hi')).toEqual({ language: 'fr', forced: false, sdh: true });
  });

  it('does not read a language out of the TITLE', () => {
    // Scanning every token announced Norwegian for this film, and the wider the
    // table the more titles collide — is/it/id/no/la/my are ordinary words too.
    expect(subtitleTagsFromName('No.Country.For.Old.Men').language).toBe('und');
    expect(subtitleTagsFromName('Lucifer - S05E14 - Nothing Lasts Forever').language).toBe('und');
    expect(subtitleTagsFromName('Movie').language).toBe('und');
  });

  it('still finds the tag when the title contains a language word', () => {
    expect(subtitleTagsFromName('No.Country.For.Old.Men.heb').language).toBe('he');
  });

  it('lets the rightmost tag win on a dual-tagged release', () => {
    expect(subtitleTagsFromName('Movie.2020.iTA.ENG').language).toBe('en');
  });
});
