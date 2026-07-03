import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@ultratorrent/shared';
import { NAV_GROUPS, isItemActive, visibleGroups, type NavItem } from './navigation';

const allItems = NAV_GROUPS.flatMap((g) => g.items);
const item = (to: string): NavItem => {
  const found = allItems.find((i) => i.to === to);
  if (!found) throw new Error(`no nav item for ${to}`);
  return found;
};

const allow =
  (...held: string[]) =>
  (p: string) =>
    held.includes(p);
const enabled =
  (...mods: string[]) =>
  (m: string) =>
    mods.includes(m);

describe('visibleGroups (RBAC + module gating)', () => {
  it('shows every group when all permissions and modules are granted', () => {
    const groups = visibleGroups(
      () => true,
      () => true,
    );
    expect(groups.map((g) => g.title)).toEqual([
      'Overview',
      'Torrents',
      'Automation',
      'Files & Media',
      'Infrastructure',
      'Administration',
      'System',
    ]);
  });

  it('hides everything when the user holds no permissions and no modules are enabled', () => {
    const groups = visibleGroups(
      () => false,
      () => false,
    );
    expect(groups).toHaveLength(0);
  });

  it('shows only the Torrents group (with all sub-views) for a torrents-only user', () => {
    const groups = visibleGroups(allow(PERMISSIONS.TORRENTS_VIEW), enabled('torrents'));
    expect(groups.map((g) => g.title)).toEqual(['Torrents']);
    expect(groups[0].items.map((i) => i.label)).toEqual([
      'All Torrents',
      'Downloading',
      'Seeding',
      'Completed',
      'Paused',
      'Errors',
    ]);
  });

  it('drops a group whose module is disabled even when the permission is held', () => {
    // All permissions, but the torrents module is off → Torrents group vanishes.
    const groups = visibleGroups(
      () => true,
      (m) => m !== 'torrents',
    );
    expect(groups.map((g) => g.title)).not.toContain('Torrents');
    // A permission-only item with no module gate still shows.
    expect(groups.map((g) => g.title)).toContain('Administration');
  });

  it('keeps permission-gated, module-less items visible without any modules', () => {
    const groups = visibleGroups(allow(PERMISSIONS.MODULES_VIEW), () => false);
    const admin = groups.find((g) => g.title === 'Administration');
    expect(admin?.items.map((i) => i.label)).toEqual(['Modules']);
  });
});

describe('isItemActive (query-aware)', () => {
  it('marks "All Torrents" active only with no state filter', () => {
    expect(isItemActive(item('/torrents'), '/torrents', '')).toBe(true);
    expect(isItemActive(item('/torrents'), '/torrents', '?state=downloading')).toBe(false);
  });

  it('marks a sub-view active only for its own state param', () => {
    const dl = item('/torrents?state=downloading');
    expect(isItemActive(dl, '/torrents', '?state=downloading')).toBe(true);
    expect(isItemActive(dl, '/torrents', '?state=seeding')).toBe(false);
    expect(isItemActive(dl, '/torrents', '')).toBe(false);
  });

  it('treats an `end` route as exact', () => {
    expect(isItemActive(item('/dashboard'), '/dashboard', '')).toBe(true);
    expect(isItemActive(item('/dashboard'), '/dashboard/settings', '')).toBe(false);
  });

  it('treats a non-`end` route as a prefix (covers detail pages)', () => {
    expect(isItemActive(item('/engines'), '/engines', '')).toBe(true);
    expect(isItemActive(item('/engines'), '/engines/abc123', '')).toBe(true);
  });
});
