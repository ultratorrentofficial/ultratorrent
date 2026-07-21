import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { SystemRole } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  Info,
  LogOut,
  UserCog,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Search,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';
import { useRealtime } from '@/realtime/RealtimeContext';
import { useVersion } from '@/hooks/useVersion';
import { AboutDialog } from '@/components/AboutDialog';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { BreadcrumbProvider } from '@/components/layout/BreadcrumbContext';
import { ContextualSubNav } from '@/components/layout/ContextualSubNav';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { LanguageSwitcher } from '@/components/layout/LanguageSwitcher';
import {
  activeEntryId,
  flattenForSearch,
  isBranchActive,
  isItemActive,
  tNav,
  visibleGroups,
  type NavItem,
  type NavGroup,
  type NavSearchEntry,
} from '@/components/layout/navigation';
import { formatSpeedCompact } from '@/lib/format';
import { readStringSet, toggleInSet, writeStringSet } from '@/lib/persist-set';
import { useNavBadges, type NavBadge } from '@/components/layout/useNavBadges';
import { useNavPersonalization } from '@/components/layout/useNavPersonalization';
import { usePaletteProviders } from '@/components/layout/usePaletteProviders';
import { cn } from '@/lib/utils';

/** A count/dot status badge on a nav item. Collapsed rail shows just a dot. */
function NavBadgePill({ badge, collapsed }: { badge: NavBadge; collapsed?: boolean }) {
  const tone =
    badge.tone === 'danger'
      ? 'bg-destructive text-destructive-foreground'
      : badge.tone === 'warning'
        ? 'bg-warning text-warning-foreground'
        : 'bg-primary text-primary-foreground';
  if (collapsed) {
    // A small corner dot on the icon — the count lives in the flyout / expanded rail.
    return (
      <span
        aria-hidden
        className={cn('absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-card/80', tone)}
      />
    );
  }
  const text = badge.count != null ? (badge.count > 99 ? '99+' : String(badge.count)) : badge.label ?? '';
  return (
    <span
      aria-label={badge.label}
      className={cn('ml-auto min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none', tone)}
    >
      {text}
    </span>
  );
}

const COLLAPSE_KEY = 'ut.sidebar.collapsed';
const GROUPS_COLLAPSED_KEY = 'ut.nav.groups.collapsed';
const ITEMS_EXPANDED_KEY = 'ut.nav.items.expanded';

export function AppShell() {
  const { hasPermission, user } = useAuth();
  const { isEnabled } = useModules();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });

  // Prowlarr companion shortcut: only fetch when the user may view it; the nav
  // item shows only when the integration is enabled with a public URL set.
  const canViewProwlarr = hasPermission(PERMISSIONS.INTEGRATIONS_PROWLARR_VIEW);
  const { data: prowlarr } = useQuery({
    queryKey: ['prowlarr', 'settings'],
    queryFn: () => api.prowlarr.get(),
    enabled: canViewProwlarr,
    staleTime: 60_000,
  });
  const externalHref = useCallback(
    (id: string): string | null => {
      if (id === 'prowlarr') return prowlarr?.enabled && prowlarr.publicUrl ? prowlarr.publicUrl : null;
      return null;
    },
    [prowlarr],
  );

  const groups = useMemo(
    () =>
      visibleGroups({
        hasPermission,
        isEnabled,
        canManageModules: hasPermission(PERMISSIONS.MODULES_MANAGE),
        isSuperAdmin: Boolean(user?.roles?.includes(SystemRole.SUPER_ADMIN)),
        externalHref,
      }),
    [hasPermission, isEnabled, user, externalHref],
  );

  const searchEntries = useMemo(() => flattenForSearch(groups), [groups]);
  const personalization = useNavPersonalization();
  const { actions: paletteActions, entitySources: paletteEntities } = usePaletteProviders();
  const location = useLocation();

  // Remember visited pages for the "Recent" quick-access list. A detail route folds
  // into its parent nav entry via activeEntryId.
  const { recordVisit } = personalization;
  useEffect(() => {
    const id = activeEntryId(searchEntries, location.pathname);
    if (id) recordVisit(id);
  }, [location.pathname, searchEntries, recordVisit]);

  // Pinned entries → simple leaf items for the top-of-rail section (RBAC already
  // applied to searchEntries, so a pin to a now-hidden page just won't resolve).
  const byId = useMemo(() => new Map(searchEntries.map((e) => [e.id, e])), [searchEntries]);
  const pinnedItems: NavItem[] = useMemo(
    () =>
      [...personalization.pinned]
        .map((id) => byId.get(id))
        .filter((e): e is NavSearchEntry => !!e && !!e.to)
        .map((e) => ({ id: e.id, label: e.label, icon: e.icon, to: e.to })),
    [personalization.pinned, byId],
  );

  // Global Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <BreadcrumbProvider>
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <Sidebar
        groups={groups}
        collapsed={collapsed}
        pinnedItems={pinnedItems}
        onUnpin={personalization.togglePin}
        onToggleCollapsed={toggleCollapsed}
        onAbout={() => setAboutOpen(true)}
        onOpenCommand={() => setPaletteOpen(true)}
        className="hidden lg:flex"
      />

      {/* Mobile sidebar drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <Sidebar
            groups={groups}
            collapsed={false}
            pinnedItems={pinnedItems}
            onUnpin={personalization.togglePin}
            onAbout={() => {
              setMobileOpen(false);
              setAboutOpen(true);
            }}
            onOpenCommand={() => {
              setMobileOpen(false);
              setPaletteOpen(true);
            }}
            className="absolute left-0 top-0 bottom-0 z-10 animate-slide-in-right"
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onMenu={() => setMobileOpen(true)}
          onAbout={() => setAboutOpen(true)}
          onOpenCommand={() => setPaletteOpen(true)}
        />
        <ContextualSubNav />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        entries={searchEntries}
        onNavigate={(to) => navigate(to)}
        actions={paletteActions}
        entitySources={paletteEntities}
        pinned={personalization.pinned}
        favorites={personalization.favorites}
        recent={personalization.recent}
        onTogglePin={personalization.togglePin}
        onToggleFavorite={personalization.toggleFavorite}
      />
    </div>
    </BreadcrumbProvider>
  );
}

/** A single leaf row (a real route or the Search action). */
function NavRow({
  item,
  collapsed,
  depth = 0,
  badge,
  onNavigate,
  onOpenCommand,
}: {
  item: NavItem;
  collapsed?: boolean;
  depth?: number;
  badge?: NavBadge;
  onNavigate?: () => void;
  onOpenCommand?: () => void;
}) {
  const Icon = item.icon;
  const location = useLocation();
  const { t } = useTranslation('nav');
  const isActive = isItemActive(item, location.pathname, location.search);
  const label = tNav(t, 'items', item.label);

  const classes = cn(
    'group relative flex items-center gap-3 rounded-lg text-sm font-medium transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
    !collapsed && depth > 0 && 'ml-3 pl-6',
    isActive
      ? 'bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
  );
  const badgeEl = badge ? <NavBadgePill badge={badge} collapsed={collapsed} /> : null;
  const iconEl = (
    <Icon
      className={cn(
        'h-[18px] w-[18px] shrink-0 transition-colors',
        depth > 0 && !collapsed && 'h-4 w-4',
        isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
      )}
    />
  );

  // The Search entry is an action (opens the command palette), not a route.
  if (item.action === 'command') {
    return (
      <button
        type="button"
        onClick={() => onOpenCommand?.()}
        title={collapsed ? label : undefined}
        aria-label={label}
        className={cn(classes, 'w-full text-left')}
      >
        {iconEl}
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && (
          <kbd className="ml-auto hidden rounded border border-border/60 px-1 py-0.5 text-[9px] text-muted-foreground/70 xl:inline">⌘K</kbd>
        )}
      </button>
    );
  }

  // External link (e.g. the Prowlarr companion) — opens in a new tab.
  if (item.external && item.href) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        title={collapsed ? label : undefined}
        aria-label={label}
        className={classes}
      >
        {iconEl}
        {collapsed && badgeEl}
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />}
      </a>
    );
  }

  return (
    <Link
      to={item.to ?? '#'}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      className={classes}
    >
      {iconEl}
      {collapsed && badgeEl}
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badgeEl}
    </Link>
  );
}

/** A parent row with a collapsible sub-menu (chevron toggles children). */
function NavParent({
  item,
  collapsed,
  expanded,
  onToggle,
  badges,
  onNavigate,
  onOpenCommand,
}: {
  item: NavItem;
  collapsed?: boolean;
  expanded: boolean;
  onToggle: () => void;
  badges?: Record<string, NavBadge>;
  onNavigate?: () => void;
  onOpenCommand?: () => void;
}) {
  const location = useLocation();
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const branchActive = isBranchActive(item, location.pathname, location.search);
  const selfActive = isItemActive(item, location.pathname, location.search);
  const label = tNav(t, 'items', item.label);
  const Icon = item.icon;

  // In the icon rail, just show the parent as a link to its landing route.
  if (collapsed) {
    return <NavRow item={item} collapsed onNavigate={onNavigate} onOpenCommand={onOpenCommand} />;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn(
          'group flex items-center rounded-lg text-sm font-medium transition-all',
          branchActive && !selfActive ? 'text-foreground' : '',
          selfActive
            ? 'bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
            : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
        )}
      >
        <Link
          to={item.to ?? '#'}
          onClick={onNavigate}
          aria-current={selfActive ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className={cn('h-[18px] w-[18px] shrink-0', selfActive || branchActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
          <span className="truncate">{label}</span>
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? tShell('nav.collapseItem', { name: label }) : tShell('nav.expandItem', { name: label })}
          className="mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5">
          {(item.children ?? []).map((child) => (
            <NavRow key={child.id} item={child} depth={1} badge={badges?.[child.id]} onNavigate={onNavigate} onOpenCommand={onOpenCommand} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavGroupBlock({
  group,
  collapsed,
  groupOpen,
  onToggleGroup,
  expandedItems,
  onToggleItem,
  badges,
  onNavigate,
  onOpenCommand,
}: {
  group: NavGroup;
  collapsed?: boolean;
  groupOpen: boolean;
  onToggleGroup: () => void;
  expandedItems: Set<string>;
  onToggleItem: (id: string) => void;
  badges?: Record<string, NavBadge>;
  onNavigate?: () => void;
  onOpenCommand?: () => void;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const location = useLocation();
  const title = tNav(t, 'groups', group.title);
  const groupActive = group.items.some((i) => isBranchActive(i, location.pathname, location.search));
  // Auto-expand a group that contains the active route, even if user-collapsed.
  const open = groupOpen || groupActive;

  const renderItem = (item: NavItem) => {
    if (item.children && item.children.length > 0) {
      const itemActive = item.children.some((c) => isBranchActive(c, location.pathname, location.search)) ||
        isItemActive(item, location.pathname, location.search);
      return (
        <NavParent
          key={item.id}
          item={item}
          collapsed={collapsed}
          expanded={expandedItems.has(item.id) || itemActive}
          onToggle={() => onToggleItem(item.id)}
          badges={badges}
          onNavigate={onNavigate}
          onOpenCommand={onOpenCommand}
        />
      );
    }
    return <NavRow key={item.id} item={item} collapsed={collapsed} badge={badges?.[item.id]} onNavigate={onNavigate} onOpenCommand={onOpenCommand} />;
  };

  return (
    <div role="group" aria-label={title} className="flex flex-col gap-1">
      {collapsed ? (
        <div className="mx-2 my-1 h-px bg-border/40" aria-hidden />
      ) : (
        <div className="group/hdr flex items-center gap-1 px-1 pb-0.5 pt-3">
          <button
            type="button"
            onClick={onToggleGroup}
            aria-expanded={open}
            aria-label={open ? tShell('nav.collapseGroup', { name: title }) : tShell('nav.expandGroup', { name: title })}
            className="rounded p-0.5 text-muted-foreground/70 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
          </button>
          {/* The title links to the domain's landing hub; the chevron toggles. */}
          <Link
            to={`/hub/${group.id}`}
            onClick={onNavigate}
            className="flex-1 rounded text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </Link>
        </div>
      )}
      {(collapsed || open) && group.items.map(renderItem)}
    </div>
  );
}

/** Does any item (or child) in the group carry a badge? Drives the domain-icon dot. */
function groupHasBadge(group: NavGroup, badges: Record<string, NavBadge>): boolean {
  return group.items.some((i) => badges[i.id] || (i.children ?? []).some((c) => badges[c.id]));
}

/** The contents of a collapsed-rail flyout: the group's title and its items. */
function FlyoutGroup({
  group,
  badges,
  onNavigate,
  onOpenCommand,
}: {
  group: NavGroup;
  badges: Record<string, NavBadge>;
  onNavigate?: () => void;
  onOpenCommand?: () => void;
}) {
  const { t } = useTranslation('nav');
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {tNav(t, 'groups', group.title)}
      </p>
      {group.items.map((item) => (
        <div key={item.id} className="flex flex-col gap-0.5">
          <NavRow item={item} badge={badges[item.id]} onNavigate={onNavigate} onOpenCommand={onOpenCommand} />
          {(item.children ?? []).map((child) => (
            <NavRow key={child.id} item={child} depth={1} badge={badges[child.id]} onNavigate={onNavigate} onOpenCommand={onOpenCommand} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The collapsed icon rail as a **domain switcher** (the A+B hybrid): one icon per
 * domain, and hovering (or focusing) one opens a flyout with that domain's pages — so
 * the rail never grows with the feature count, yet every page stays one hover away.
 * A small delay on close lets the pointer travel from icon into the flyout.
 */
function CollapsedRail({
  groups,
  badges,
  onNavigate,
  onOpenCommand,
}: {
  groups: NavGroup[];
  badges: Record<string, NavBadge>;
  onNavigate?: () => void;
  onOpenCommand?: () => void;
}) {
  const { t } = useTranslation('nav');
  const location = useLocation();
  const [flyout, setFlyout] = useState<{ group: NavGroup; top: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const open = (group: NavGroup, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    setFlyout({ group, top: el.getBoundingClientRect().top });
  };
  const scheduleClose = () => {
    timer.current = window.setTimeout(() => setFlyout(null), 140);
  };
  const cancelClose = () => window.clearTimeout(timer.current);

  return (
    <div className="flex flex-col items-center gap-1">
      {groups.map((group) => {
        const Icon = group.icon;
        const title = tNav(t, 'groups', group.title);
        const active = group.items.some((i) => isBranchActive(i, location.pathname, location.search));
        // The domain icon links to its landing hub (a "domain home"); hovering opens
        // the flyout with the domain's pages.
        return (
          <Link
            key={group.id}
            to={`/hub/${group.id}`}
            onMouseEnter={(e) => open(group, e.currentTarget)}
            onMouseLeave={scheduleClose}
            onFocus={(e) => open(group, e.currentTarget)}
            onBlur={scheduleClose}
            onClick={onNavigate}
            aria-label={title}
            title={title}
            className={cn(
              'relative grid h-10 w-10 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
            {groupHasBadge(group, badges) && (
              <span aria-hidden className="absolute right-1 top-1 h-2 w-2 rounded-full bg-warning ring-2 ring-card/80" />
            )}
          </Link>
        );
      })}

      {flyout && (
        <div
          role="menu"
          aria-label={tNav(t, 'groups', flyout.group.title)}
          className="fixed z-[70] w-60 rounded-xl border border-border/60 bg-card/95 p-2 shadow-2xl backdrop-blur-xl"
          style={{ top: Math.max(8, flyout.top), left: '4.75rem' }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <FlyoutGroup
            group={flyout.group}
            badges={badges}
            onNavigate={() => {
              setFlyout(null);
              onNavigate?.();
            }}
            onOpenCommand={onOpenCommand}
          />
        </div>
      )}
    </div>
  );
}

/** The user's pinned pages, shown at the very top of the rail. */
function PinnedSection({
  items,
  collapsed,
  onUnpin,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  onUnpin?: (id: string) => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const location = useLocation();
  if (items.length === 0) return null;

  return (
    <div role="group" aria-label={tShell('nav.pinned')} className="flex flex-col gap-0.5 pb-1">
      {!collapsed && (
        <div className="flex items-center gap-1 px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          <Pin className="h-3 w-3" aria-hidden />
          <span>{tShell('nav.pinned')}</span>
        </div>
      )}
      {items.map((item) => {
        const Icon = item.icon;
        const active = isItemActive(item, location.pathname, location.search);
        const label = tNav(t, 'items', item.label);
        return (
          <div key={item.id} className={cn('group relative flex items-center', collapsed && 'justify-center')}>
            <Link
              to={item.to ?? '#'}
              onClick={onNavigate}
              aria-label={label}
              title={collapsed ? label : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-3 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
                active
                  ? 'bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
                  : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
              )}
            >
              <Icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
            {!collapsed && onUnpin && (
              <button
                type="button"
                onClick={() => onUnpin(item.id)}
                aria-label={tShell('nav.unpin', { name: label })}
                title={tShell('nav.unpin', { name: label })}
                className="absolute right-1 rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
              >
                <PinOff className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
      <div className="mx-2 mt-1 h-px bg-border/40" aria-hidden />
    </div>
  );
}

function Sidebar({
  groups,
  collapsed,
  pinnedItems,
  onUnpin,
  className,
  onNavigate,
  onToggleCollapsed,
  onAbout,
  onOpenCommand,
}: {
  groups: NavGroup[];
  collapsed: boolean;
  pinnedItems?: NavItem[];
  onUnpin?: (id: string) => void;
  className?: string;
  onNavigate?: () => void;
  onToggleCollapsed?: () => void;
  onAbout?: () => void;
  onOpenCommand?: () => void;
}) {
  const { t } = useTranslation('shell');
  const badges = useNavBadges();
  const [collapsedGroups, setCollapsedGroups] = useState(() => readStringSet(GROUPS_COLLAPSED_KEY));
  const [expandedItems, setExpandedItems] = useState(() => readStringSet(ITEMS_EXPANDED_KEY));
  const toggleGroup = useCallback(
    (id: string) => setCollapsedGroups((s) => toggleInSet(GROUPS_COLLAPSED_KEY, s, id)),
    [],
  );
  const toggleItem = useCallback(
    (id: string) => setExpandedItems((s) => toggleInSet(ITEMS_EXPANDED_KEY, s, id)),
    [],
  );
  const collapseAll = useCallback(() => {
    const all = new Set(groups.map((g) => g.id));
    writeStringSet(GROUPS_COLLAPSED_KEY, all);
    setCollapsedGroups(all);
  }, [groups]);
  const expandAll = useCallback(() => {
    const empty = new Set<string>();
    writeStringSet(GROUPS_COLLAPSED_KEY, empty);
    setCollapsedGroups(empty);
  }, []);
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedGroups.has(g.id));

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col gap-1 border-r border-border/60 bg-card/40 backdrop-blur-xl p-3 transition-[width] duration-200',
        collapsed ? 'w-[4.5rem]' : 'w-64',
        className,
      )}
    >
      <div className="relative flex items-center justify-center px-1 py-4">
        {collapsed ? (
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent text-sm font-bold text-primary-foreground">
            UT
          </span>
        ) : (
          <img src="/logo.png" alt="UltraTorrent" className="w-full max-w-[13rem] object-contain" />
        )}
        {onNavigate && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label={t('menu.close')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-white/5 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="flex items-center justify-end gap-0.5 px-1 pb-0.5">
          <button
            type="button"
            onClick={allCollapsed ? expandAll : collapseAll}
            aria-label={allCollapsed ? t('nav.expandAll') : t('nav.collapseAll')}
            title={allCollapsed ? t('nav.expandAll') : t('nav.collapseAll')}
            className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {allCollapsed ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
          </button>
        </div>
      )}

      <nav
        aria-label={t('nav.primary')}
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden scrollbar-thin"
      >
        <PinnedSection items={pinnedItems ?? []} collapsed={collapsed} onUnpin={onUnpin} onNavigate={onNavigate} />
        {collapsed ? (
          <CollapsedRail groups={groups} badges={badges} onNavigate={onNavigate} onOpenCommand={onOpenCommand} />
        ) : (
          groups.map((group) => (
            <NavGroupBlock
              key={group.id}
              group={group}
              collapsed={false}
              groupOpen={!collapsedGroups.has(group.id)}
              onToggleGroup={() => toggleGroup(group.id)}
              expandedItems={expandedItems}
              onToggleItem={toggleItem}
              badges={badges}
              onNavigate={onNavigate}
              onOpenCommand={onOpenCommand}
            />
          ))
        )}
      </nav>

      <div className="mt-1 flex flex-col gap-2">
        <div
          className={cn(
            'rounded-lg border border-border/60 bg-white/[0.02]',
            collapsed ? 'grid place-items-center p-2' : 'p-3',
          )}
        >
          {!collapsed && (
            <p className="text-[11px] font-medium text-muted-foreground">{t('engine.label')}</p>
          )}
          <EngineMini collapsed={collapsed} />
        </div>

        <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
          <VersionBadge collapsed={collapsed} onClick={onAbout} />
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              aria-expanded={!collapsed}
              title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              className="hidden rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-[18px] w-[18px]" />
              ) : (
                <PanelLeftClose className="h-[18px] w-[18px]" />
              )}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function VersionBadge({ collapsed, onClick }: { collapsed?: boolean; onClick?: () => void }) {
  const { data } = useVersion();
  const { t } = useTranslation('shell');
  const version = data?.version ? `v${data.version}` : '';
  // Always show the abbreviated commit hash (short git SHA) next to the version,
  // in white — so every build's exact commit is visible, releases included.
  // Only absent when the build wasn't git-stamped (no gitSha).
  const commit = data?.gitSha ? data.gitSha.slice(0, 7) : '';
  const ariaVersion = commit ? `${version} - (${commit})` : version;
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('about.triggerLabel')}
      aria-label={version ? t('about.triggerLabelWithVersion', { version: ariaVersion }) : t('about.triggerLabel')}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed && 'px-2',
      )}
    >
      <Info className="h-[18px] w-[18px] shrink-0" />
      {!collapsed &&
        (version ? (
          <span className="tabular-nums">
            <span className="text-emerald-300">{version}</span>
            {commit && <span className="text-white"> - ({commit})</span>}
          </span>
        ) : (
          <span className="tabular-nums">{t('about.trigger')}</span>
        ))}
    </button>
  );
}

function EngineMini({ collapsed }: { collapsed?: boolean }) {
  const { engineOnline, status } = useRealtime();
  const { t } = useTranslation('shell');
  const online = engineOnline ?? status === 'connected';
  return (
    <div
      className={cn('flex items-center gap-2', !collapsed && 'mt-1.5')}
      title={online ? t('engine.onlineTitle') : t('engine.offlineTitle')}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          online ? 'bg-success animate-pulse-soft' : 'bg-destructive',
        )}
      />
      {!collapsed && (
        <span className="text-xs font-medium">
          {online ? t('engine.online') : t('engine.offline')}
        </span>
      )}
    </div>
  );
}

function TopBar({ onMenu, onAbout, onOpenCommand }: { onMenu: () => void; onAbout: () => void; onOpenCommand: () => void }) {
  const { stats, status } = useRealtime();
  const { t } = useTranslation('shell');
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label={t('menu.open')}
        className="rounded-md p-2 text-muted-foreground hover:bg-white/5 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenCommand}
          aria-label={t('command.open')}
          title={t('command.open')}
          className="flex items-center gap-2 rounded-lg border border-border/60 bg-white/[0.02] px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="h-4 w-4" />
          <span className="hidden md:inline">{t('command.search')}</span>
          <kbd className="hidden rounded border border-border/60 px-1 py-0.5 text-[9px] md:inline">⌘K</kbd>
        </button>
        <SpeedPill
          icon={<ArrowDown className="h-3.5 w-3.5" />}
          value={formatSpeedCompact(stats?.downloadRate)}
          tone="info"
        />
        <SpeedPill
          icon={<ArrowUp className="h-3.5 w-3.5" />}
          value={formatSpeedCompact(stats?.uploadRate)}
          tone="success"
        />
        <ConnectionDot status={status} />
        <LanguageSwitcher className="hidden sm:flex" />
        <UserMenu onAbout={onAbout} />
      </div>
    </header>
  );
}

function SpeedPill({
  icon,
  value,
  tone,
}: {
  icon: React.ReactNode;
  value: string;
  tone: 'info' | 'success';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums glass-subtle',
        tone === 'info' ? 'text-info' : 'text-success',
      )}
    >
      {icon}
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const { t } = useTranslation('shell');
  const map: Record<string, { color: string; label: string }> = {
    connected: { color: 'bg-success', label: t('connection.connected') },
    connecting: { color: 'bg-warning animate-pulse', label: t('connection.connecting') },
    disconnected: { color: 'bg-destructive', label: t('connection.offline') },
  };
  const s = map[status] ?? map.disconnected;
  return (
    <div className="hidden items-center sm:flex" title={s.label}>
      <span className={cn('h-2.5 w-2.5 rounded-full', s.color)} />
    </div>
  );
}

function UserMenu({ onAbout }: { onAbout: () => void }) {
  const { user, logout } = useAuth();
  const { data: version } = useVersion();
  const { t } = useTranslation('shell');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const initials = (user?.displayName ?? user?.username ?? '?')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-border/60 bg-white/[0.02] py-1 pl-1 pr-2.5 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-bold text-primary-foreground">
          {initials}
        </span>
        <span className="hidden text-sm font-medium sm:inline">
          {user?.displayName ?? user?.username}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg glass p-1.5 shadow-card animate-scale-in">
            <div className="px-3 py-2.5">
              <p className="truncate text-sm font-semibold">
                {user?.displayName ?? user?.username}
              </p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              {user?.roles?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <span
                      key={role}
                      className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {role.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="my-1 h-px bg-border/60" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/account');
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-white/5"
            >
              <UserCog className="h-4 w-4" />
              {t('user.accountSecurity')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAbout();
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-white/5"
            >
              <Info className="h-4 w-4" />
              <span className="flex-1 text-left">{t('about.triggerLabel')}</span>
              {version?.version && (
                <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                  v{version.version}
                  {version.gitSha ? ` - (${version.gitSha.slice(0, 7)})` : ''}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              {t('user.signOut')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
