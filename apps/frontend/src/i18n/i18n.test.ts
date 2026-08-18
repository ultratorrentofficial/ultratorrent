import { describe, expect, it } from 'vitest';
import i18n, { NAMESPACES, SUPPORTED_LANGUAGES } from './index';
import { NAV_GROUPS, type NavItem } from '@/components/layout/navigation';

/** Recursively collect every dotted leaf key of a resource bundle. */
function flatKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

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

  /**
   * Parity proves both languages carry the same keys; it cannot prove either is
   * REACHABLE. A string added as a flat dotted key beside a nested object of
   * the same name — `"afterTargetOption.remove_torrent_and_staging_data"` next
   * to an `afterTargetOption: {…}` — is shadowed: i18next walks into the object,
   * finds no such member, and renders the raw key at the operator. It appeared
   * in both locales, so parity was satisfied while the UI showed
   * `scheduler.policies.seeding.afterTargetOption.remove_torrent_and_staging_data`
   * in a dropdown.
   */
  it('resolves every key it ships, in both languages', () => {
    const MISSING = '__UNRESOLVED__';
    const unresolved: string[] = [];
    for (const lng of ['en-US', 'es-PR']) {
      for (const ns of NAMESPACES) {
        for (const key of flatKeys(i18n.getResourceBundle(lng, ns) ?? {})) {
          // Plural leaves are reached as `base` + `count`, never by their own
          // suffixed name, so asking for them directly proves nothing.
          if (/_(zero|one|two|few|many|other)$/.test(key)) continue;
          // The sentinel is the only sound signal: a key may legitimately
          // resolve to its own name (`"yes": "yes"`), so comparing output to
          // key would fail three honest strings.
          const out = i18n.t(key, { ns, lng, defaultValue: MISSING });
          if (out === MISSING) unresolved.push(`${lng}/${ns}: ${key}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('has identical key sets across en-US and es-PR for every namespace (parity)', () => {
    for (const ns of NAMESPACES) {
      const en = flatKeys(i18n.getResourceBundle('en-US', ns) ?? {}).sort();
      const es = flatKeys(i18n.getResourceBundle('es-PR', ns) ?? {}).sort();
      expect({ ns, keys: es }).toEqual({ ns, keys: en });
    }
  });
});

describe('navigation i18n coverage (no hardcoded nav strings)', () => {
  const labels: string[] = [];
  const descKeys: string[] = [];
  const groups: string[] = [];
  const walk = (item: NavItem) => {
    labels.push(item.label);
    if (item.descriptionKey) descKeys.push(item.descriptionKey);
    (item.children ?? []).forEach(walk);
  };
  NAV_GROUPS.forEach((g) => {
    groups.push(g.title);
    g.items.forEach(walk);
  });

  it('resolves every nav group title in both languages', () => {
    for (const lng of ['en-US', 'es-PR'] as const) {
      const t = i18n.getFixedT(lng, 'nav');
      for (const title of groups) {
        expect(i18n.exists(`groups.${title}`, { ns: 'nav', lng })).toBe(true);
        expect(t(`groups.${title}` as 'groups.Overview')).toBeTruthy();
      }
    }
  });

  it('resolves every nav item label in both languages', () => {
    for (const lng of ['en-US', 'es-PR'] as const) {
      for (const label of labels) {
        expect(i18n.exists(`items.${label}`, { ns: 'nav', lng })).toBe(true);
      }
    }
  });

  it('resolves every declared description key in both languages', () => {
    for (const lng of ['en-US', 'es-PR'] as const) {
      for (const key of descKeys) {
        expect(i18n.exists(`descriptions.${key}`, { ns: 'nav', lng })).toBe(true);
      }
    }
  });
});
