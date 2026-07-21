import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NAV_GROUPS, type NavItem } from './navigation';

/**
 * Structural guard: every in-app nav destination (`item.to`) must map to a real
 * route declared in `App.tsx`. Off-app links (`external`) and pure actions are
 * exempt. This catches a nav entry pointing at a route that was renamed or never
 * added — a dead link the sidebar/hub/palette would otherwise surface.
 */
// cwd is the repo root or the frontend package depending on the runner; resolve
// against both candidates so the test is invariant to how vitest is launched.
const APP_TSX = ['apps/frontend/src/App.tsx', 'src/App.tsx']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p))!;

/** All route templates declared in App.tsx (`path="..."`), minus the catch-all. */
function routeTemplates(): string[] {
  const src = readFileSync(APP_TSX, 'utf8');
  const paths = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
  return paths.filter((p) => p.startsWith('/') && p !== '*');
}

/** A nav path matches a route template if segments align, `:param` matching any. */
function matches(navPath: string, template: string): boolean {
  const a = navPath.split('/').filter(Boolean);
  const b = template.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return b.every((seg, i) => seg.startsWith(':') || seg === a[i]);
}

function navDestinations(): { id: string; to: string }[] {
  const out: { id: string; to: string }[] = [];
  const walk = (item: NavItem) => {
    if (item.to && !item.external) out.push({ id: item.id, to: item.to.split('?')[0] });
    (item.children ?? []).forEach(walk);
  };
  NAV_GROUPS.forEach((g) => g.items.forEach(walk));
  return out;
}

describe('nav has no dead links', () => {
  const templates = routeTemplates();

  it('extracts the app route table', () => {
    expect(templates.length).toBeGreaterThan(10);
    expect(templates).toContain('/dashboard');
  });

  it.each(navDestinations())('$id → $to maps to a real route', ({ to }) => {
    expect(templates.some((tpl) => matches(to, tpl))).toBe(true);
  });
});
