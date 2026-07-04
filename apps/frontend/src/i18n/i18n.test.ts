import { describe, expect, it } from 'vitest';
import i18n, { NAMESPACES, SUPPORTED_LANGUAGES } from './index';

describe('i18n', () => {
  it('registers exactly en-US and es-PR', () => {
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toEqual(['en-US', 'es-PR']);
  });

  it('loads all namespaces for both languages', () => {
    for (const lng of ['en-US', 'es-PR']) {
      for (const ns of NAMESPACES) {
        expect(i18n.hasResourceBundle(lng, ns)).toBe(true);
      }
    }
  });

  it('resolves a sample key differently per language', () => {
    const en = i18n.getFixedT('en-US', 'auth');
    const es = i18n.getFixedT('es-PR', 'auth');
    expect(en('signIn')).toBe('Sign in');
    expect(es('signIn')).toBe('Iniciar sesión');
    expect(en('signIn')).not.toBe(es('signIn'));
  });

  it('falls back to en-US for an unknown language', () => {
    const t = i18n.getFixedT('fr-FR', 'auth');
    expect(t('signIn')).toBe('Sign in');
  });
});
