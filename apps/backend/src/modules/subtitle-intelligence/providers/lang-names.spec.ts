import { langNameToCode } from './lang-names';

describe('langNameToCode', () => {
  it('maps language names to ISO-639-1 codes, case-insensitively', () => {
    expect(langNameToCode('English')).toBe('en');
    expect(langNameToCode('arabic')).toBe('ar');
    expect(langNameToCode('Brazilian Portuguese')).toBe('pt');
    expect(langNameToCode('Farsi/Persian')).toBe('fa');
  });
  it('returns und for an unknown name', () => {
    expect(langNameToCode('Klingon')).toBe('und');
  });
});
