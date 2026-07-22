import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { tNav, type NavGroup } from '@/components/layout/navigation';
import { useNavBadges } from '@/components/layout/useNavBadges';
import { cn } from '@/lib/utils';

/** Does any item (or child) in the workspace carry a badge? Drives the rail dot. */
function workspaceHasBadge(group: NavGroup, badges: Record<string, { count?: number } | undefined>): boolean {
  return group.items.some((i) => badges[i.id] || (i.children ?? []).some((c) => badges[c.id]));
}

/**
 * The **workspace switcher** — the fixed global rail. One icon per visible workspace
 * (RBAC/module-filtered upstream, so an empty workspace never appears); selecting one
 * navigates to its landing and swaps the sidebar for that workspace's own nav. This is
 * the *only* global navigation surface; it never grows as modules are added. Desktop
 * only (`lg:flex`); mobile uses {@link MobileDomainBar}.
 */
export function WorkspaceRail({
  groups,
  activeId,
  landingFor,
  onSelect,
  sidebarHidden,
  onToggleSidebar,
}: {
  groups: NavGroup[];
  activeId: string | undefined;
  landingFor: (g: NavGroup) => string;
  onSelect: (g: NavGroup) => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const badges = useNavBadges();

  return (
    <nav
      aria-label={tShell('nav.workspaces')}
      className="hidden w-[4.5rem] shrink-0 flex-col items-center gap-1 border-r border-border/60 bg-card/60 py-3 backdrop-blur-xl lg:flex"
    >
      {/* Brand mark */}
      <Link
        to="/dashboard"
        aria-label="UltraTorrent"
        className="mb-2 grid h-10 w-10 shrink-0 place-items-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* alt="" — the link already carries the accessible name. */}
        <img src="/logo-mark.png" alt="" className="h-10 w-10 object-contain" />
      </Link>

      <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-none">
        {groups.map((group, i) => {
          const active = group.id === activeId;
          const Icon = group.icon;
          const label = tNav(t, 'groups', group.title);
          const shortcut = i < 9 ? `Ctrl+${i + 1}` : undefined;
          return (
            <Link
              key={group.id}
              to={landingFor(group)}
              onClick={() => onSelect(group)}
              aria-current={active ? 'page' : undefined}
              aria-keyshortcuts={shortcut ? `Control+${i + 1}` : undefined}
              title={shortcut ? `${label} (${shortcut})` : label}
              className={cn(
                'group relative grid h-11 w-11 place-items-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
              )}
            >
              {/* Active indicator bar */}
              <span
                className={cn(
                  'absolute -left-3 h-6 w-1 rounded-r-full bg-primary transition-opacity',
                  active ? 'opacity-100' : 'opacity-0',
                )}
                aria-hidden
              />
              <Icon className="h-5 w-5" />
              {workspaceHasBadge(group, badges) && (
                <span
                  className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
                  aria-hidden
                />
              )}
            </Link>
          );
        })}
      </div>

      {/* Hide/show the workspace sidebar (reclaim content space) */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarHidden ? tShell('sidebar.expand') : tShell('sidebar.collapse')}
        aria-pressed={sidebarHidden}
        title={sidebarHidden ? tShell('sidebar.expand') : tShell('sidebar.collapse')}
        className="mt-1 grid h-10 w-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {sidebarHidden ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
      </button>
    </nav>
  );
}
