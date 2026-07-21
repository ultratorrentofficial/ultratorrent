import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu } from 'lucide-react';
import { resolveActiveContext, tNav } from '@/components/layout/navigation';
import { useVisibleNavGroups } from '@/components/layout/useVisibleNavGroups';
import { cn } from '@/lib/utils';

/**
 * A bottom domain switcher for mobile: one tap jumps to any domain's landing hub,
 * so switching modules doesn't require opening the full drawer. Horizontally
 * scrollable when there are more domains than fit. Hidden on desktop (`lg:hidden`),
 * where the sidebar already provides this. The active domain is highlighted via
 * {@link resolveActiveContext}. A trailing "Menu" button opens the full drawer for
 * everything the bar doesn't surface (deep sub-pages, account, etc.).
 */
export function MobileDomainBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const location = useLocation();
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const groups = useVisibleNavGroups();
  const activeGroupId = resolveActiveContext(groups, location.pathname, location.search)?.group.id;

  return (
    <nav
      aria-label={tShell('nav.domains')}
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch gap-0.5 overflow-x-auto border-t border-border/60 bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl scrollbar-none lg:hidden"
    >
      {groups.map((group) => {
        const active = group.id === activeGroupId;
        const Icon = group.icon;
        return (
          <Link
            key={group.id}
            to={`/hub/${group.id}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-w-[4.25rem] shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="max-w-full truncate">{tNav(t, 'groups', group.title)}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMenu}
        className="flex min-w-[4.25rem] shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
        <span>{tShell('nav.menu')}</span>
      </button>
    </nav>
  );
}
