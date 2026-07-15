import { baseLang, missingLanguages } from './missing-languages';

describe('baseLang', () => {
  it('drops region and case', () => {
    expect(baseLang('en-US')).toBe('en');
    expect(baseLang('ES')).toBe('es');
    expect(baseLang('pt_BR')).toBe('pt');
  });
});

describe('missingLanguages', () => {
  it('returns wanted languages not already present', () => {
    expect(missingLanguages(['en'], ['en', 'es'])).toEqual(['es']);
    expect(missingLanguages([], ['en'])).toEqual(['en']);
    expect(missingLanguages(['en', 'es'], ['en', 'es'])).toEqual([]);
  });

  it('matches on the base language across region variants', () => {
    expect(missingLanguages(['en-US'], ['en'])).toEqual([]);
    expect(missingLanguages(['en'], ['en-GB'])).toEqual([]);
  });

  it('ignores undetermined present tags', () => {
    expect(missingLanguages(['und'], ['en'])).toEqual(['en']);
  });

  it('de-duplicates the wanted list by base language', () => {
    expect(missingLanguages([], ['en', 'en-US', 'es'])).toEqual(['en', 'es']);
  });
});
