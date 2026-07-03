import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Info,
  LogOut,
  UserCog,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';
import { useRealtime } from '@/realtime/RealtimeContext';
import { useVersion } from '@/hooks/useVersion';
import { AboutDialog } from '@/components/AboutDialog';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { isItemActive, visibleGroups, type NavItem, type NavGroup } from '@/components/layout/navigation';
import { formatSpeedCompact } from '@/lib/format';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'ut.sidebar.collapsed';

export function AppShell() {
  const { hasPermission } = useAuth();
  const { isEnabled } = useModules();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
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

  const groups = visibleGroups(hasPermission, isEnabled);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <Sidebar
        groups={groups}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onAbout={() => setAboutOpen(true)}
        className="hidden lg:flex"
      />

      {/* Mobile sidebar */}
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
            onAbout={() => {
              setMobileOpen(false);
              setAboutOpen(true);
            }}
            className="absolute left-0 top-0 bottom-0 z-10 animate-slide-in-right"
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} onAbout={() => setAboutOpen(true)} />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}

function NavRow({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const location = useLocation();
  const isActive = isItemActive(item, location.pathname, location.search);
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-lg text-sm font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
        isActive
          ? 'bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
          : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'h-[18px] w-[18px] shrink-0 transition-colors',
          isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function NavGroupBlock({
  group,
  collapsed,
  onNavigate,
}: {
  group: NavGroup;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div role="group" aria-label={group.title} className="flex flex-col gap-1">
      {collapsed ? (
        <div className="mx-2 my-1 h-px bg-border/40" aria-hidden />
      ) : (
        <p className="px-3 pb-0.5 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {group.title}
        </p>
      )}
      {group.items.map((item) => (
        <NavRow key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function Sidebar({
  groups,
  collapsed,
  className,
  onNavigate,
  onToggleCollapsed,
  onAbout,
}: {
  groups: NavGroup[];
  collapsed: boolean;
  className?: string;
  onNavigate?: () => void;
  onToggleCollapsed?: () => void;
  onAbout?: () => void;
}) {
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
            aria-label="Close menu"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-white/5 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden scrollbar-thin"
      >
        {groups.map((group) => (
          <NavGroupBlock
            key={group.title}
            group={group}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="mt-1 flex flex-col gap-2">
        <div
          className={cn(
            'rounded-lg border border-border/60 bg-white/[0.02]',
            collapsed ? 'grid place-items-center p-2' : 'p-3',
          )}
        >
          {!collapsed && <p className="text-[11px] font-medium text-muted-foreground">Engine</p>}
          <EngineMini collapsed={collapsed} />
        </div>

        <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
          <VersionBadge collapsed={collapsed} onClick={onAbout} />
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
  const label = data?.version ? `v${data.version}` : '';
  return (
    <button
      type="button"
      onClick={onClick}
      title="About UltraTorrent"
      aria-label={`About UltraTorrent${label ? ` — ${label}` : ''}`}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed && 'px-2',
      )}
    >
      <Info className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="tabular-nums">{label || 'About'}</span>}
    </button>
  );
}

function EngineMini({ collapsed }: { collapsed?: boolean }) {
  const { engineOnline, status } = useRealtime();
  const online = engineOnline ?? status === 'connected';
  return (
    <div
      className={cn('flex items-center gap-2', !collapsed && 'mt-1.5')}
      title={online ? 'Engine online' : 'Engine offline'}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          online ? 'bg-success animate-pulse-soft' : 'bg-destructive',
        )}
      />
      {!collapsed && <span className="text-xs font-medium">{online ? 'Online' : 'Offline'}</span>}
    </div>
  );
}

function TopBar({ onMenu, onAbout }: { onMenu: () => void; onAbout: () => void }) {
  const { stats, status } = useRealtime();
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open menu"
        className="rounded-md p-2 text-muted-foreground hover:bg-white/5 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
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
  const map: Record<string, { color: string; label: string }> = {
    connected: { color: 'bg-success', label: 'Realtime connected' },
    connecting: { color: 'bg-warning animate-pulse', label: 'Connecting…' },
    disconnected: { color: 'bg-destructive', label: 'Realtime offline' },
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
              Account &amp; security
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
              <span className="flex-1 text-left">About UltraTorrent</span>
              {version?.version && (
                <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                  v{version.version}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
