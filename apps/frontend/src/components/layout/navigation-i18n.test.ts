import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_CONTRIBUTIONS } from './navigation';

/**
 * Every nav entry must have a translation in every locale.
 *
 * The typed `t()` keys the rest of the app relies on do not cover this: nav
 * labels are plain strings resolved at runtime against nav.json, so a missing
 * entry compiles, ships, and renders as the raw key path — a sidebar reading
 * "Items.Server Users" made it to production this way.
 */

const LOCALES = ['en-US', 'es-PR'] as const;

function navJson(locale: string): { items: Record<string, string>; descriptions: Record<string, string> } {
  const p = join(__dirname, '..', '..', 'i18n', 'locales', locale, 'nav.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Walks children too — a sub-item is exactly where one gets forgotten. */
function collect(): { labels: string[]; descriptionKeys: string[] } {
  const labels: string[] = [];
  const descriptionKeys: string[] = [];
  const visit = (item: { label?: string; descriptionKey?: string; children?: unknown[] }) => {
    if (item.label) labels.push(item.label);
    if (item.descriptionKey) descriptionKeys.push(item.descriptionKey);
    for (const child of item.children ?? []) visit(child as never);
  };
  for (const slot of NAV_CONTRIBUTIONS) visit(slot.item as never);
  return { labels, descriptionKeys };
}

describe('navigation translations', () => {
  const { labels, descriptionKeys } = collect();

  it('finds nav entries to check', () => {
    expect(labels.length).toBeGreaterThan(20);
  });

  it.each(LOCALES)('%s translates every nav label', (locale) => {
    const { items } = navJson(locale);
    const missing = labels.filter((l) => !(l in items));
    expect(missing, `would render as "Items.<label>" in ${locale}`).toEqual([]);
  });

  it.each(LOCALES)('%s translates every nav description', (locale) => {
    const { descriptions } = navJson(locale);
    const missing = descriptionKeys.filter((k) => !(k in descriptions));
    expect(missing, `missing nav descriptions in ${locale}`).toEqual([]);
  });

  it('keeps the locales in step with each other', () => {
    const [a, b] = LOCALES.map(navJson);
    expect(Object.keys(a.items).sort()).toEqual(Object.keys(b.items).sort());
    expect(Object.keys(a.descriptions).sort()).toEqual(Object.keys(b.descriptions).sort());
  });
});
