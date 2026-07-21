import {
  Award,
  Bot,
  Boxes,
  Captions,
  CheckCircle2,
  Clapperboard,
  Copy,
  Cpu,
  Download,
  Film,
  FolderTree,
  IdCard,
  Languages,
  Library,
  SearchX,
  SlidersHorizontal,
  Wand2,
  PauseCircle,
  TriangleAlert,
  Upload,
  LayoutDashboard,
  ListChecks,
  Radar,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tv,
  FlaskConical,
  Gauge,
  Globe,
  MonitorPlay,
  Plug,
  Server,
  Activity,
  History,
  BarChart3,
  DownloadCloud,
  Mail,
  UserCircle,
  Users,
  Bell,
  Send,
  FileText,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Permission } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';

export type NavIcon = React.ComponentType<{ className?: string }>;

/**
 * Translate a nav group title / item / description by its canonical English key.
 * The `NAV_GROUPS` data structure stays in English (tests assert on it); the
 * shell, breadcrumbs and command palette call this at RENDER time. The dynamic-key
 * cast is contained here — the `nav` resources are keyed by canonical English.
 */
export function tNav(
  t: TFunction<'nav'>,
  section: 'groups' | 'items' | 'descriptions' | 'details',
  english: string,
): string {
  return t(`${section}.${english}` as 'groups.Overview');
}

/**
 * A single navigation entry. A leaf has a `to` (route) or an `action`; a parent
 * has `children` and may also have its own `to` (a landing page for the branch).
 * All user-facing text is a canonical-English key resolved through {@link tNav}.
 */
export interface NavItem {
  /** Stable id (used for keys, persisted expand state, tests). */
  id: string;
  /** Canonical-English label key. */
  label: string;
  icon: NavIcon;
  /** Route path. Omitted for pure parents or action items. */
  to?: string;
  /** A non-navigation action instead of a route. */
  action?: 'command';
  /**
   * External link — opens in a new tab instead of routing. The live URL is
   * resolved at filter time via {@link NavVisibilityCtx.externalHref} (so a
   * companion app like Prowlarr appears only when configured/enabled); the
   * resolved value is written back onto {@link href}.
   */
  external?: boolean;
  /** Resolved external URL (runtime-populated for `external` items). */
  href?: string;
  /** Nested sub-menu. */
  children?: NavItem[];
  /** RBAC gate — hidden unless the user holds this permission. */
  permission?: Permission;
  /** Module gate — hidden when the module is disabled (unless the user can manage modules). */
  module?: string;
  /** Exact-match the route for active styling (no prefix match). */
  end?: boolean;
  /** Only visible to users who can manage modules (admin surface). */
  adminOnly?: boolean;
  /** Only visible to super admins. */
  superAdminOnly?: boolean;
  /** Optional one-line description key (command palette / tooltips). */
  descriptionKey?: string;
}

/** A titled, collapsible top-level group. The header hides in the icon rail. */
export interface NavGroup {
  id: string;
  title: string;
  icon: NavIcon;
  items: NavItem[];
}

/**
 * The navigation information architecture — the single source of truth for the
 * sidebar, breadcrumbs and command palette. Every `to` maps to a real route in
 * `App.tsx`; do not add an entry without a matching route. Items are gated by
 * `permission` (RBAC) and/or `module` (enablement). Groups/parents with no
 * visible children are dropped, so RBAC + module state naturally collapse the
 * menu. Keep in sync with `docs/NAVIGATION.md`.
 *
 * Note: several spec sub-features (e.g. Metadata Providers, Artwork, Subtitles,
 * NFO tooling, Triggers & Actions, Root Paths, API Keys) are *sections within* an
 * existing page rather than standalone routes; they appear under their page entry
 * rather than as dead links. See `docs/NAVIGATION.md` for the full mapping.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: LayoutDashboard,
    items: [
      { id: 'dashboard', to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard', end: true, descriptionKey: 'Dashboard' },
      { id: 'search', action: 'command', label: 'Search', icon: Search, descriptionKey: 'Search' },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    icon: Download,
    items: [
      {
        id: 'torrents',
        to: '/torrents',
        label: 'Torrents',
        icon: ListChecks,
        permission: PERMISSIONS.TORRENTS_VIEW,
        module: 'torrents',
        end: true,
        descriptionKey: 'Torrents',
        children: [
          { id: 'torrents-downloading', to: '/torrents?state=downloading', label: 'Downloading', icon: Download, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
          { id: 'torrents-seeding', to: '/torrents?state=seeding', label: 'Seeding', icon: Upload, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
          { id: 'torrents-completed', to: '/torrents?state=completed', label: 'Completed', icon: CheckCircle2, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
          { id: 'torrents-paused', to: '/torrents?state=paused', label: 'Paused', icon: PauseCircle, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
          { id: 'torrents-error', to: '/torrents?state=error', label: 'Errors', icon: TriangleAlert, permission: PERMISSIONS.TORRENTS_VIEW, module: 'torrents' },
        ],
      },
      { id: 'rss', to: '/rss', label: 'RSS Feeds', icon: Rss, permission: PERMISSIONS.RSS_VIEW, module: 'rss', descriptionKey: 'RSS Feeds' },
      { id: 'indexers', to: '/indexers', label: 'Indexers', icon: Radar, permission: PERMISSIONS.INDEXERS_VIEW, descriptionKey: 'Indexers' },
      // Optional Prowlarr companion — shown only when configured + enabled (its
      // live URL is resolved at filter time) and the user may open it.
      { id: 'prowlarr', label: 'Prowlarr', icon: Globe, external: true, permission: PERMISSIONS.INTEGRATIONS_PROWLARR_OPEN, descriptionKey: 'Prowlarr' },
      { id: 'release-scoring', to: '/release-scoring', label: 'Release Scoring', icon: Award, permission: PERMISSIONS.RELEASE_SCORING_VIEW, module: 'release_scoring', descriptionKey: 'Release Scoring' },
      {
        id: 'acquisition-intelligence',
        to: '/media-acquisition',
        label: 'Acquisition Intelligence',
        icon: Sparkles,
        permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW,
        module: 'media_acquisition_intelligence',
        end: true,
        descriptionKey: 'Acquisition Intelligence',
        children: [
          { id: 'smart-download', to: '/media-acquisition/dashboard', label: 'Smart Download', icon: Gauge, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence', descriptionKey: 'Smart Download' },
          { id: 'missing-episodes', to: '/media-acquisition/missing-episodes', label: 'Missing Episodes', icon: Tv, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence', descriptionKey: 'Missing Episodes' },
          { id: 'decision-simulator', to: '/media-acquisition/simulator', label: 'Decision Simulator', icon: FlaskConical, permission: PERMISSIONS.MEDIA_ACQUISITION_VIEW, module: 'media_acquisition_intelligence', descriptionKey: 'Decision Simulator' },
        ],
      },
      { id: 'engines', to: '/engines', label: 'Engines', icon: Cpu, permission: PERMISSIONS.SYSTEM_VIEW, descriptionKey: 'Engines' },
    ],
  },
  {
    id: 'media',
    title: 'Media',
    icon: Clapperboard,
    items: [
      { id: 'media-dashboard', to: '/media', label: 'Media Dashboard', icon: Clapperboard, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', end: true, descriptionKey: 'Media Dashboard' },
      { id: 'media-items', to: '/media/items', label: 'Media Items', icon: Film, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'Media Items' },
      { id: 'media-libraries', to: '/media/libraries', label: 'Libraries', icon: Library, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'Libraries' },
      { id: 'media-unmatched', to: '/media/unmatched', label: 'Unmatched Media', icon: SearchX, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'Unmatched Media' },
      { id: 'media-duplicates', to: '/media/duplicates', label: 'Duplicates', icon: Copy, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'Duplicates' },
      { id: 'media-rename', to: '/media/rename-preview', label: 'Rename Engine', icon: Wand2, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'Rename Engine' },
      {
        id: 'subtitles',
        to: '/subtitles',
        label: 'Subtitles',
        icon: Captions,
        permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW,
        module: 'subtitle_intelligence',
        end: true,
        descriptionKey: 'Subtitles',
        children: [
          { id: 'subtitles-search', to: '/subtitles/search', label: 'Subtitle Search', icon: Search, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_SEARCH, module: 'subtitle_intelligence', descriptionKey: 'Subtitle Search' },
          { id: 'subtitles-sync', to: '/subtitles/sync', label: 'Subtitle Sync', icon: Wand2, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', descriptionKey: 'Subtitle Sync' },
          { id: 'subtitles-validation', to: '/subtitles/validation', label: 'Subtitle Validation', icon: CheckCircle2, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', descriptionKey: 'Subtitle Validation' },
          { id: 'subtitles-languages', to: '/subtitles/languages', label: 'Subtitle Languages', icon: Languages, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', descriptionKey: 'Subtitle Languages' },
          { id: 'subtitles-history', to: '/subtitles/history', label: 'Subtitle History', icon: History, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', descriptionKey: 'Subtitle History' },
          { id: 'subtitles-providers', to: '/subtitles/providers', label: 'Subtitle Providers', icon: Plug, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', descriptionKey: 'Subtitle Providers' },
          { id: 'subtitles-settings', to: '/subtitles/settings', label: 'Subtitle Settings', icon: SlidersHorizontal, permission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW, module: 'subtitle_intelligence', end: true, descriptionKey: 'Subtitle Settings' },
        ],
      },
      { id: 'media-imdb', to: '/media/settings/imdb', label: 'IMDb Settings', icon: IdCard, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', descriptionKey: 'IMDb Settings' },
      { id: 'media-settings', to: '/media/settings', label: 'Media Settings', icon: SlidersHorizontal, permission: PERMISSIONS.MEDIA_MANAGER_VIEW, module: 'media_manager', end: true, descriptionKey: 'Media Settings' },
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    icon: Bot,
    items: [
      { id: 'automation', to: '/automation', label: 'Automation Rules', icon: Bot, permission: PERMISSIONS.AUTOMATION_VIEW, module: 'automation', descriptionKey: 'Automation Rules' },
      {
        id: 'notifications',
        to: '/notifications',
        label: 'Notifications',
        icon: Bell,
        permission: PERMISSIONS.NOTIFICATIONS_VIEW,
        module: 'notification_center',
        end: true,
        descriptionKey: 'Notifications',
        children: [
          { id: 'nc-channels', to: '/notifications/channels', label: 'Notification Channels', icon: Send, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Notification Channels' },
          { id: 'nc-rules', to: '/notifications/rules', label: 'Notification Rules', icon: ListChecks, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Notification Rules' },
          { id: 'nc-templates', to: '/notifications/templates', label: 'Notification Templates', icon: FileText, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Notification Templates' },
          { id: 'nc-recipients', to: '/notifications/recipients', label: 'Notification Recipients', icon: Users, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Notification Recipients' },
          { id: 'nc-groups', to: '/notifications/groups', label: 'Recipient Groups', icon: Users, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Recipient Groups' },
          { id: 'nc-history', to: '/notifications/history', label: 'Delivery History', icon: History, permission: PERMISSIONS.NOTIFICATIONS_VIEW_HISTORY, module: 'notification_center', descriptionKey: 'Delivery History' },
          { id: 'nc-queue', to: '/notifications/queue', label: 'Queue Monitor', icon: Gauge, permission: PERMISSIONS.NOTIFICATIONS_VIEW_HISTORY, module: 'notification_center', descriptionKey: 'Queue Monitor' },
          { id: 'nc-health', to: '/notifications/provider-health', label: 'Provider Health', icon: Activity, permission: PERMISSIONS.NOTIFICATIONS_VIEW, module: 'notification_center', descriptionKey: 'Provider Health' },
          { id: 'nc-prefs', to: '/notifications/preferences', label: 'Notification Preferences', icon: SlidersHorizontal, permission: PERMISSIONS.NOTIFICATIONS_MANAGE_PREFERENCES, module: 'notification_center', descriptionKey: 'Notification Preferences' },
          { id: 'nc-settings', to: '/notifications/settings', label: 'Notification Settings', icon: Settings, permission: PERMISSIONS.NOTIFICATIONS_MANAGE_SETTINGS, module: 'notification_center', descriptionKey: 'Notification Settings' },
        ],
      },
    ],
  },
  {
    id: 'files',
    title: 'Files',
    icon: FolderTree,
    items: [
      { id: 'files', to: '/files', label: 'File Manager', icon: FolderTree, permission: PERMISSIONS.FILES_VIEW, module: 'files', descriptionKey: 'File Manager' },
    ],
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    icon: Activity,
    items: [
      {
        id: 'media-server-analytics',
        to: '/media-server-analytics',
        label: 'Media Server Analytics',
        icon: MonitorPlay,
        permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW,
        module: 'media_server_analytics',
        end: true,
        descriptionKey: 'Media Server Analytics',
        children: [
          { id: 'msa-live', to: '/media-server-analytics/live', label: 'Live Activity', icon: Activity, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, module: 'media_server_analytics', descriptionKey: 'Live Activity' },
          { id: 'msa-recent', to: '/media-server-analytics/recently-added', label: 'Recently Added', icon: Clapperboard, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW, module: 'media_server_analytics', descriptionKey: 'Recently Added' },
          { id: 'msa-history', to: '/media-server-analytics/watch-history', label: 'Watch History', icon: History, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_HISTORY, module: 'media_server_analytics', descriptionKey: 'Watch History' },
          { id: 'msa-reports', to: '/media-server-analytics/reports', label: 'Analytics Reports', icon: BarChart3, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS, module: 'media_server_analytics', descriptionKey: 'Analytics Reports' },
          { id: 'msa-newsletters', to: '/media-server-analytics/newsletters', label: 'Newsletters', icon: Mail, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS, module: 'media_server_analytics', descriptionKey: 'Newsletters' },
          { id: 'msa-import', to: '/media-server-analytics/import', label: 'Import Analytics', icon: DownloadCloud, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS, module: 'media_server_analytics', descriptionKey: 'Import Analytics' },
          { id: 'msa-connections', to: '/media-server-analytics/connections', label: 'Server Connections', icon: Server, permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW, module: 'media_server_analytics', descriptionKey: 'Server Connections' },
        ],
      },
    ],
  },
  {
    id: 'administration',
    title: 'Administration',
    icon: ShieldCheck,
    items: [
      { id: 'users', to: '/users', label: 'Users', icon: Users, permission: PERMISSIONS.USERS_VIEW, module: 'users', descriptionKey: 'Users' },
      { id: 'modules', to: '/modules', label: 'Modules', icon: Boxes, permission: PERMISSIONS.MODULES_VIEW, descriptionKey: 'Modules' },
      { id: 'settings', to: '/settings', label: 'Settings', icon: Settings, permission: PERMISSIONS.SETTINGS_VIEW, module: 'settings', descriptionKey: 'Settings' },
      { id: 'audit', to: '/audit', label: 'Audit Log', icon: ShieldCheck, permission: PERMISSIONS.AUDIT_VIEW, module: 'audit', descriptionKey: 'Audit Log' },
    ],
  },
  {
    id: 'account',
    title: 'Account',
    icon: UserCircle,
    items: [
      { id: 'account', to: '/account', label: 'Profile', icon: UserCircle, end: true, descriptionKey: 'Profile' },
    ],
  },
];

/** Context needed to decide whether a nav entry is visible to the current user. */
export interface NavVisibilityCtx {
  hasPermission: (p: Permission) => boolean;
  isEnabled: (m: string) => boolean;
  /** Users who can manage modules still see disabled-module entries (they lead to the locked page). */
  canManageModules: boolean;
  isSuperAdmin: boolean;
  /**
   * Resolve an `external` item's live target URL by id. Return a non-empty URL
   * to show the item (linking there), or null/undefined to hide it (e.g. the
   * companion app is disabled or unconfigured). Optional — items without
   * `external` ignore it.
   */
  externalHref?: (id: string) => string | null | undefined;
}

/** Whether a single item passes its own gates (ignoring children). */
function selfVisible(item: NavItem, ctx: NavVisibilityCtx): boolean {
  if (item.permission && !ctx.hasPermission(item.permission)) return false;
  if (item.superAdminOnly && !ctx.isSuperAdmin) return false;
  if (item.adminOnly && !ctx.canManageModules) return false;
  // Module gate: hidden when disabled — unless the user can manage modules
  // (module state is convenience-only; route guards remain authoritative).
  if (item.module && !ctx.isEnabled(item.module) && !ctx.canManageModules) return false;
  return true;
}

/** Recursively filter an item; returns null when it (and all children) are hidden. */
function filterItem(item: NavItem, ctx: NavVisibilityCtx): NavItem | null {
  if (!selfVisible(item, ctx)) return null;
  // External items resolve their live URL at filter time; a missing URL means
  // "not configured/enabled" → hidden. The resolved URL rides on `href`.
  let resolved = item;
  if (item.external) {
    const href = ctx.externalHref?.(item.id) ?? undefined;
    if (!href) return null;
    resolved = { ...item, href };
  }
  const children = (item.children ?? [])
    .map((c) => filterItem(c, ctx))
    .filter((c): c is NavItem => c !== null);
  // A pure parent (no destination/action/link) with no visible children is dropped.
  if (!resolved.to && !resolved.action && !resolved.href && children.length === 0) return null;
  return resolved.children ? { ...resolved, children } : resolved;
}

/**
 * Filter the IA to what the current user may see. An item survives its RBAC +
 * module gates; a group with no visible items is dropped so no bare header
 * renders. UI hiding is convenience only — the server remains authoritative.
 */
export function visibleGroups(ctx: NavVisibilityCtx): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((i) => filterItem(i, ctx)).filter((i): i is NavItem => i !== null),
  })).filter((group) => group.items.length > 0);
}

/** A flattened, navigable entry for the command palette / search. */
export interface NavSearchEntry {
  id: string;
  label: string;
  descriptionKey?: string;
  icon: NavIcon;
  to?: string;
  action?: 'command';
  groupId: string;
  groupTitle: string;
}

/** Flatten the (already-filtered) groups into navigable entries for search. */
export function flattenForSearch(groups: NavGroup[]): NavSearchEntry[] {
  const out: NavSearchEntry[] = [];
  const walk = (item: NavItem, group: NavGroup) => {
    if (item.to || item.action) {
      out.push({
        id: item.id,
        label: item.label,
        descriptionKey: item.descriptionKey,
        icon: item.icon,
        to: item.to,
        action: item.action,
        groupId: group.id,
        groupTitle: group.title,
      });
    }
    (item.children ?? []).forEach((c) => walk(c, group));
  };
  groups.forEach((g) => g.items.forEach((i) => walk(i, g)));
  return out;
}

/**
 * Query-aware active check for a nav item. Torrents sub-views differ only by a
 * `?state=` query param, so we compare that too; the base "Torrents" (`end`) is
 * active only with no filter. Non-`end` items match on path prefix (so detail
 * routes like `/media/items/:id` keep their parent active).
 */
export function isItemActive(item: NavItem, pathname: string, searchStr: string): boolean {
  if (!item.to) return false;
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

/** Whether an item or any of its descendants is the active route (for highlight + auto-expand). */
export function isBranchActive(item: NavItem, pathname: string, searchStr: string): boolean {
  if (isItemActive(item, pathname, searchStr)) return true;
  return (item.children ?? []).some((c) => isBranchActive(c, pathname, searchStr));
}
