import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cleanupEn from '@/i18n/locales/en-US/cleanup.json';
import torrentsEn from '@/i18n/locales/en-US/torrents.json';

/**
 * The builder is shared between Media Purge and the Activity Scheduler, and it
 * names two different kinds of thing:
 *
 *  - its own CHROME ("Match when", "any of these", "Add condition"), which
 *    belongs to the builder and lives in one bundle however many catalogues
 *    use it;
 *  - the CATALOGUE's labels and descriptions, which follow the caller.
 *
 * Running both through the caller's bundle put raw keys on screen —
 * "builder.matchWhen", "builder.expects.number" — for every catalogue except
 * the one the builder came from. i18next renders the key when it cannot
 * resolve it, so the failure is silent to every check except looking at it.
 */
const source = readFileSync(join(__dirname, 'ConditionBuilder.tsx'), 'utf8');
/**
 * Resolve a key the way i18next does here: walk the nested path, and fall back
 * to a FLAT key containing dots (`cond.releaseYear.desc`), which is how both
 * catalogues are actually written and which i18next finds via its
 * `ignoreJSONStructure` default. Plural keys are stored as `_one`/`_other`.
 */
const lookup = (bundle: unknown, dotted: string): unknown => {
  const nested = dotted.split('.').reduce<unknown>(
    (acc, part) => (acc as Record<string, unknown>)?.[part], bundle,
  );
  if (nested !== undefined) return nested;
  const parts = dotted.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const parent = parts.slice(0, i).reduce<unknown>(
      (acc, part) => (acc as Record<string, unknown>)?.[part], bundle,
    ) as Record<string, unknown> | undefined;
    const rest = parts.slice(i).join('.');
    if (parent?.[rest] !== undefined) return parent[rest];
    if (parent?.[`${rest}_one`] !== undefined) return parent[`${rest}_one`];
  }
  return undefined;
};

describe('the builder resolves every string it renders', () => {
  it('has a cleanup entry for every builder.* key in the component', () => {
    const keys = [...source.matchAll(/[`']builder\.([a-zA-Z.]+)[`']/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    const missing = [...new Set(keys)].filter((k) => lookup(cleanupEn, `builder.${k}`) === undefined);
    expect(missing).toEqual([]);
  });

  it('has a torrents entry for every seeding condition the scheduler catalogue names', () => {
    // Mirrors SEED_CONDITIONS' label/description keys; the backend serves them,
    // so a typo here shows up as an unresolved key rather than an error.
    const ids = ['ratio', 'ageDays', 'uploaded', 'seedMinutes', 'tracker', 'isPrivate',
      'size', 'name', 'category', 'label', 'library', 'imported', 'copyVerified'];
    const missing = ids.flatMap((id) => [`sched.cond.${id}`, `sched.cond.${id}.desc`])
      .filter((k) => lookup(torrentsEn, k) === undefined);
    expect(missing).toEqual([]);
  });

  it('reads catalogue labels through the caller bundle and chrome through its own', () => {
    // The split that was broken: one translator per kind of string.
    expect(source).toContain("const { t } = useTranslation('cleanup');");
    expect(source).toContain('const { t: tLabel } = useTranslation(namespace);');
    expect(source).toMatch(/tLabel\(d\.labelKey/);
    expect(source).toMatch(/tLabel\(def\.descriptionKey/);
  });
});
