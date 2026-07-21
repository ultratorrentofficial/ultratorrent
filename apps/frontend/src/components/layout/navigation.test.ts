import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  NAV_GROUPS,
  NAV_DOMAINS,
  NAV_CONTRIBUTIONS,
  activeEntryId,
  composeNavGroups,
  flattenForSearch,
  isBranchActive,
  isItemActive,
  visibleGroups,
  type NavContribution,
  type NavItem,
  type NavVisibilityCtx,
} from './navigation';
import { Boxes } from 'lucide-react';

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

describe('composeNavGroups (registry-driven rail)', () => {
  const domains = [
    { id: 'a', title: 'A', icon: Boxes, order: 20 },
    { id: 'b', title: 'B', icon: Boxes, order: 10 },
  ];
  const item = (id: string): NavItem => ({ id, to: `/${id}`, label: id, icon: Boxes });

  it('orders domains by domain.order and items by slot.order', () => {
    const contribs: NavContribution[] = [
      { slot: { domain: 'a', order: 20 }, item: item('a2') },
      { slot: { domain: 'a', order: 10 }, item: item('a1') },
      { slot: { domain: 'b', order: 10 }, item: item('b1') },
    ];
    const groups = composeNavGroups(domains, contribs);
    expect(groups.map((g) => g.id)).toEqual(['b', 'a']); // B (order 10) before A (order 20)
    expect(groups[1].items.map((i) => i.id)).toEqual(['a1', 'a2']); // slot order within A
  });

  it('drops a domain with no contributions', () => {
    const groups = composeNavGroups(domains, [{ slot: { domain: 'a', order: 10 }, item: item('a1') }]);
    expect(groups.map((g) => g.id)).toEqual(['a']); // B has nothing → gone
  });

  it('routes an unknown domain into an auto-appended Extensions area (plugin support)', () => {
    const contribs: NavContribution[] = [
      { slot: { domain: 'a', order: 10 }, item: item('a1') },
      { slot: { domain: 'plugin-x', order: 10 }, item: item('px') }, // unknown domain
    ];
    const groups = composeNavGroups(domains, contribs);
    const ext = groups.find((g) => g.id === 'extensions');
    expect(ext).toBeTruthy();
    expect(ext!.items.map((i) => i.id)).toEqual(['px']);
    // Extensions sits last (order 200 > any domain).
    expect(groups[groups.length - 1].id).toBe('extensions');
  });

  it('never appends an empty Extensions area when every domain is known', () => {
    const groups = composeNavGroups(NAV_DOMAINS, NAV_CONTRIBUTIONS);
    expect(groups.some((g) => g.id === 'extensions')).toBe(false);
  });

  it('the exported NAV_GROUPS is the composed result', () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(composeNavGroups().map((g) => g.id));
    // Every contribution's item id appears in the composed rail.
    const railIds = new Set(NAV_GROUPS.flatMap((g) => g.items).map((i) => i.id));
    for (const c of NAV_CONTRIBUTIONS) expect(railIds.has(c.item.id)).toBe(true);
  });
});

describe('visibleGroups (RBAC + module gating)', () => {
  it('shows every group in order when all permissions and modules are granted', () => {
    expect(visibleGroups(ALL).map((g) => g.title)).toEqual([
      'Dashboard',
      'Downloads',
      'Media',
      'Automation',
      'Files',
      'Monitoring',
      'Administration',
      'Account',
    ]);
  });

  it('keeps only ungated entries (Search, Profile) when the user holds nothing', () => {
    const groups = visibleGroups(ctx({}));
    expect(groups.map((g) => g.title)).toEqual(['Dashboard', 'Account']);
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

  it('hides a module-gated item when the module is disabled and the user cannot manage modules', () => {
    // Media Manager items are gated; with the module off (and no manage rights) the
    // Media domain has no visible Media-Manager entries.
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.MEDIA_MANAGER_VIEW], mods: [] }));
    const media = groups.find((g) => g.title === 'Media');
    expect(media?.items.some((i) => i.id === 'media-dashboard')).not.toBe(true);
  });

  it('keeps disabled-module entries visible for a module manager (they lead to the locked page)', () => {
    const groups = visibleGroups(ctx({ perms: [PERMISSIONS.MEDIA_MANAGER_VIEW], mods: [], canManageModules: true }));
    const media = groups.find((g) => g.title === 'Media');
    expect(media?.items.map((i) => i.id)).toContain('media-dashboard');
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

describe('activeEntryId (recent-page resolution)', () => {
  const entries = flattenForSearch(visibleGroups(ALL));

  it('resolves an exact route to its entry', () => {
    expect(activeEntryId(entries, '/media/items')).toBe('media-items');
  });

  it('folds a detail route into its parent nav entry', () => {
    // /media/items/:id has no nav entry of its own → its parent list page.
    expect(activeEntryId(entries, '/media/items/abc123')).toBe('media-items');
  });

  it('prefers the longest prefix (a nested route over its ancestor)', () => {
    // /subtitles and /subtitles/search both match /subtitles/search — pick the deeper.
    expect(activeEntryId(entries, '/subtitles/search')).toBe('subtitles-search');
  });

  it('returns undefined for a route with no nav entry', () => {
    expect(activeEntryId(entries, '/nowhere')).toBeUndefined();
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
