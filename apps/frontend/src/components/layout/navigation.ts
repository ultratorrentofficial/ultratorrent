import {
  Award,
  Bot,
  Boxes,
  CheckCircle2,
  Clapperboard,
  Copy,
  Cpu,
  Download,
  Film,
  FolderTree,
  Library,
  SearchX,
  SlidersHorizontal,
  Wand2,
  PauseCircle,
  TriangleAlert,
  Upload,
  LayoutDashboard,
  ListChecks,
  Rss,
  Settings,
  ShieldCheck,
  Sparkles,
  Tv,
  FlaskConical,
  Gauge,
  MonitorPlay,
  Server,
  Activity,
  History,
  BarChart3,
  Users,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Permission } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';

/**
 * Translate a nav group title / item / detail label by its canonical English
 * key. The `NAV_GROUPS` data structure stays in English (tests assert on it);
 * the shell + breadcrumbs call this at RENDER time. The dynamic-key cast is
 * contained here — the `nav` resources are keyed by the canonical English text.
 */
export function tNav(
  t: TFunction<'nav'>,
  section: 'groups' | 'items' | 'details',
  english: string,
): string {
  return t(`${section}.${english}` as 'groups.Overview');
}

export interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  /** When set, the item is only shown if this module is enabled. */
  module?: string;
  /** Match the route exactly (no prefix matching) for active styling. */
  end?: boolean;
}

/** A titled group of nav items. The group header hides in the collapsed rail. */
export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * The sidebar information architecture. Every `to` maps to a real route in
 * `App.tsx` — do not add entries here without a matching route. Items are
 * gated per-item by `permission` (RBAC) and/or `module` (license/enablement);
 * a group with no visible items is not rendered at all, so RBAC + licensing
 * naturally collapse the menu. Keep this in sync with `docs/NAVIGATION.md`.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard', end: true },
    ],
  },
  {
    title: 'Torrents',
    items: [
      { to: '/torrents', label: 'All Torrents', icon: ListChecks, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents', end: true },
      { to: '/torrents?state=downloading', label: 'Downloading', icon: Download, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
      { to: '/torrents?state=seeding', label: 'Seeding', icon: Upload, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
      { to: '/torrents?state=completed', label: 'Completed', icon: CheckCircle2, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
      { to: '/torrents?state=paused', label: 'Paused', icon: PauseCircle, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
      { to: '/torrents?state=error', label: 'Errors', icon: TriangleAlert, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
    ],
  },
  {
    title: 'Automation',
    items: [
      { to: '/rss', label: 'RSS Feeds', icon: Rss, permission: PERMISSIONS.RSS_VIEW, module: 'rss' },
      { to: '/automation', label: 'Automation', icon: Bot, permission: PERMISSIONS.AUTOMATION_VIEW, module: 'automation' },
    ],
  },
  {
    title: 'Files & Media',
    items: [
      { to: '/files', label: 'File Manager', icon: FolderTree, permission: PERMISSIONS.FILES_VIEW, module: 'files' },
      { to: '/media', label: 'Media Manager', icon: Clapperboard, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', end: true },
      { to: '/media/libraries', label: 'Libraries', icon: Library, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media/items', label: 'Media Items', icon: Film, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media/unmatched', label: 'Unmatched', icon: SearchX, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media/duplicates', label: 'Duplicates', icon: Copy, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media/rename-preview', label: 'Rename Preview', icon: Wand2, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media/settings', label: 'Media Settings', icon: SlidersHorizontal, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager' },
      { to: '/media-acquisition', label: 'Media Acquisition', icon: Sparkles, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence', end: true },
      { to: '/media-acquisition/dashboard', label: 'Smart Download', icon: Gauge, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence' },
      { to: '/media-acquisition/missing-episodes', label: 'Missing Episodes', icon: Tv, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence' },
      { to: '/media-acquisition/simulator', label: 'Decision Simulator', icon: FlaskConical, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence' },
      { to: '/release-scoring', label: 'Release Scoring', icon: Award, permission: PERMISSIONS.RELEASE_SCORING_VIEW, module: 'release_scoring' },
      { to: '/media-server-analytics', label: 'Media Server Analytics', icon: MonitorPlay, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW, module: 'media_server_analytics', end: true },
      { to: '/media-server-analytics/connections', label: 'Server Connections', icon: Server, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW, module: 'media_server_analytics' },
      { to: '/media-server-analytics/live', label: 'Live Activity', icon: Activity, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, module: 'media_server_analytics' },
      { to: '/media-server-analytics/watch-history', label: 'Watch History', icon: History, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_HISTORY, module: 'media_server_analytics' },
      { to: '/media-server-analytics/recently-added', label: 'Recently Added', icon: Clapperboard, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW, module: 'media_server_analytics' },
      { to: '/media-server-analytics/reports', label: 'Analytics Reports', icon: BarChart3, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS, module: 'media_server_analytics' },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { to: '/engines', label: 'Engines', icon: Cpu, permission: PERMISSIONS.SYSTEM_VIEW },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: Users, permission: PERMISSIONS.USERS_VIEW, module: 'users' },
      { to: '/modules', label: 'Modules', icon: Boxes, permission: PERMISSIONS.MODULES_VIEW },
      { to: '/settings', label: 'Settings', icon: Settings, permission: PERMISSIONS.SETTINGS_VIEW, module: 'settings' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/audit', label: 'Audit Log', icon: ShieldCheck, permission: PERMISSIONS.AUDIT_VIEW, module: 'audit' },
    ],
  },
];

/**
 * Query-aware active check for a nav item. `NavLink` only matches on pathname,
 * which would light up every `/torrents?state=…` sub-view at once; this also
 * compares the `state` query param so exactly one Torrents view is active.
 * The base "All Torrents" (`end`, `/torrents`) is active only with no filter.
 */
export function isItemActive(item: NavItem, pathname: string, searchStr: string): boolean {
  const [path, qs] = item.to.split('?');
  const params = new URLSearchParams(searchStr);
  if (qs) {
    const want = new URLSearchParams(qs).get('state');
    return pathname === path && params.get('state') === want;
  }
  if (item.end) {
    if (pathname !== path) return false;
    if (path === '/torrents') return !params.get('state');
    return true;
  }
  return pathname === path || pathname.startsWith(path + '/');
}

/**
 * Filter the nav IA down to what the current user may see: an item survives
 * when it has no permission gate (or the user holds it) AND no module gate (or
 * the module is enabled). Empty groups are dropped so no bare headers render.
 */
export function visibleGroups(
  hasPermission: (p: Permission) => boolean,
  isEnabled: (m: string) => boolean,
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (!item.permission || hasPermission(item.permission)) &&
        (!item.module || isEnabled(item.module)),
    ),
  })).filter((group) => group.items.length > 0);
}
