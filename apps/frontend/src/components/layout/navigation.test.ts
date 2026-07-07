import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  NAV_GROUPS,
  flattenForSearch,
  isBranchActive,
  isItemActive,
  visibleGroups,
  type NavItem,
  type NavVisibilityCtx,
} from './navigation';

/** Recursively find a nav item by its route. */
function findItem(to: string): NavItem {
  const walk = (items: NavItem[]): NavItem | undefined => {
    for (const i of items) {
      if (i.to === to) return i;
      const c = walk(i.children ?? []);
      if (c) return c;
    }
    return undefined;
  };
  const found = walk(NAV_GROUPS.flatMap((g) => g.items));
  if (!found) throw new Error(`no nav item for ${to}`);
  return found;
}

function ctx(o: Partial<NavVisibilityCtx> & { perms?: string[]; mods?: string[] }): NavVisibilityCtx {
  return {
    hasPermission: (p) => (o.perms ?? []).includes(p),
    isEnabled: (m) => (o.mods ?? []).includes(m),
    canManageModules: o.canManageModules ?? false,
    isSuperAdmin: o.isSuperAdmin ?? false,
  };
}

const ALL: NavVisibilityCtx = { hasPermission: () => true, isEnabled: () => true, canManageModules: true, isSuperAdmin: true };

describe('visibleGroups (RBAC + module gating)', () => {
  it('shows every group in order when all permissions and modules are granted', () => {
    expect(visibleGroups(ALL).map((g) => g.title)).toEqual([
      'Overview',
      'Downloads',
      'RSS & Acquisition',
      'Media Management',
      'Media Server Analytics',
      'Automation',
      'Files',
      'Administration',
      'Account',
    ]);
  });

  it('keeps only ungated entries (Search, Profile) when the user holds nothing', () => {
    const groups = visibleGroups(ctx({}));
    expect(groups.map((g) => g.title)).toEqual(['Overview', 'Account']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['search']); // Dashboard needs the module
    expect(groups[1].items.map((i) => i.id)).toEqual(['account']);
  });

  it('shows Downloads with the Torrents sub-menu for a torrents-only user', () => {
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.TORRENTS_VIEW], mods: ['torrents'] }));
    const downloads = groups.find((g) => g.title === 'Downloads');
    expect(downloads).toBeTruthy();
    const torrents = downloads!.items.find((i) => i.id === 'torrents')!;
    expect(torrents.children!.map((c) => c.label)).toEqual(['Downloading', 'Seeding', 'Completed', 'Paused', 'Errors']);
    // Engines (needs SYSTEM_VIEW) is filtered out of Downloads.
    expect(downloads!.items.map((i) => i.id)).not.toContain('engines');
  });

  it('hides a module-gated group when the module is disabled and the user cannot manage modules', () => {
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.MEDIA_MANAGER_VIEW], mods: [] }));
    expect(groups.map((g) => g.title)).not.toContain('Media Management');
  });

  it('keeps disabled-module entries visible for a module manager (they lead to the locked page)', () => {
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.MEDIA_MANAGER_VIEW], mods: [], canManageModules: true }));
    expect(groups.map((g) => g.title)).toContain('Media Management');
  });

  it('prunes hidden children while keeping a permitted parent', () => {
    // Media Acquisition parent + only its permitted children survive.
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.MEDIA_ACQUISITION_VIEW], mods: ['media_acquisition_intelligence'] }));
    const parent = groups.flatMap((g) => g.items).find((i) => i.id === 'acquisition-intelligence')!;
    expect(parent.children!.map((c) => c.id)).toEqual(['smart-download', 'missing-episodes', 'decision-simulator']);
  });
});

describe('flattenForSearch', () => {
  it('flattens nested items into navigable entries (children included)', () => {
    const entries = flattenForSearch(visibleGroups(ALL));
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('smart-download'); // nested child is searchable
    expect(ids).toContain('search'); // the action launcher is present (palette filters it out)
    // Every entry carries its group context.
    expect(entries.every((e) => e.groupId && e.groupTitle)).toBe(true);
  });

  it('excludes entries the user cannot see', () => {
    const entries = flattenForSearch(visibleGroups(ctx({ perms: [PERMISSIONS.TORRENTS_VIEW], mods: ['torrents'] })));
    expect(entries.some((e) => e.id === 'users')).toBe(false);
    expect(entries.some((e) => e.id === 'torrents')).toBe(true);
  });
});

describe('isItemActive (query-aware, nested + detail)', () => {
  it('marks "Torrents" active only with no state filter', () => {
    expect(isItemActive(findItem('/torrents'), '/torrents', '')).toBe(true);
    expect(isItemActive(findItem('/torrents'), '/torrents', '?state=downloading')).toBe(false);
  });

  it('marks a sub-view active only for its own state param', () => {
    const dl = findItem('/torrents?state=downloading');
    expect(isItemActive(dl, '/torrents', '?state=downloading')).toBe(true);
    expect(isItemActive(dl, '/torrents', '?state=seeding')).toBe(false);
  });

  it('treats an `end` route as exact and a non-`end` route as a prefix (detail pages)', () => {
    expect(isItemActive(findItem('/media'), '/media', '')).toBe(true);
    expect(isItemActive(findItem('/media'), '/media/items', '')).toBe(false); // end
    expect(isItemActive(findItem('/media/items'), '/media/items/abc', '')).toBe(true); // prefix → detail
  });
});

describe('isBranchActive (parent highlight + auto-expand)', () => {
  it('is active when a descendant route is active', () => {
    const parent = findItem('/media-acquisition');
    expect(isBranchActive(parent, '/media-acquisition/dashboard', '')).toBe(true);
    expect(isBranchActive(parent, '/settings', '')).toBe(false);
  });
});

describe('external companion shortcut (Prowlarr)', () => {
  const OPEN = PERMISSIONS.INTEGRATIONS_PROWLARR_OPEN;
  const base = (over: Partial<NavVisibilityCtx>): NavVisibilityCtx => ({
    hasPermission: () => false,
    isEnabled: () => true,
    canManageModules: false,
    isSuperAdmin: false,
    ...over,
  });
  const findProwlarr = (groups: ReturnType<typeof visibleGroups>) =>
    groups.flatMap((g) => g.items).find((i) => i.id === 'prowlarr');

  it('is hidden when the user lacks the open permission (even if enabled)', () => {
    const groups = visibleGroups(base({ hasPermission: () => false, externalHref: () => 'http://host:9696' }));
    expect(findProwlarr(groups)).toBeUndefined();
  });

  it('is hidden when enabled/unconfigured resolves no URL (even with permission)', () => {
    const groups = visibleGroups(base({ hasPermission: (p) => p === OPEN, externalHref: () => null }));
    expect(findProwlarr(groups)).toBeUndefined();
  });

  it('is shown with the resolved external href when permitted and configured', () => {
    const groups = visibleGroups(base({ hasPermission: (p) => p === OPEN, externalHref: () => 'http://localhost:9696' }));
    const item = findProwlarr(groups);
    expect(item).toBeDefined();
    expect(item?.external).toBe(true);
    expect(item?.href).toBe('http://localhost:9696');
    expect(item?.to).toBeUndefined();
  });
});
