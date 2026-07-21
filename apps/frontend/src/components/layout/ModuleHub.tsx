import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { tNav, type NavGroup, type NavItem } from '@/components/layout/navigation';
import { cn } from '@/lib/utils';

/**
 * A reusable **module landing hub**: an at-a-glance map of a domain built from the
 * same nav data the sidebar uses, so it never drifts. Each top-level page becomes a
 * tile (icon, name, one-line description); a page with sub-pages lists them as chips.
 * RBAC is already applied upstream (the group only contains items the user can see),
 * so a hub never surfaces a forbidden link.
 */
export function ModuleHub({ group, className }: { group: NavGroup; className?: string }) {
  const { t } = useTranslation('nav');
  // Only real destinations become tiles (skip pure action launchers like Search).
  const tiles = group.items.filter((i) => i.to || (i.children ?? []).some((c) => c.to));

  return (
    <div className={cn('space-y-5', className)}>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/15 text-primary">
          <group.icon className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight">{tNav(t, 'groups', group.title)}</h1>
          <p className="text-sm text-muted-foreground">
            {t('hub.subtitle', { count: tiles.length, domain: tNav(t, 'groups', group.title) })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((item) => (
          <HubTile key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function HubTile({ item }: { item: NavItem }) {
  const { t } = useTranslation('nav');
  const Icon = item.icon;
  const label = tNav(t, 'items', item.label);
  const desc = item.descriptionKey ? tNav(t, 'descriptions', item.descriptionKey) : '';
  const to = item.to ?? item.children?.find((c) => c.to)?.to ?? '#';
  const children = (item.children ?? []).filter((c) => c.to);

  return (
    <div className="group flex flex-col rounded-xl border border-border/60 bg-card/40 p-4 transition-colors hover:border-primary/40">
      <Link to={to} className="flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.03] text-muted-foreground group-hover:text-primary">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 font-medium text-foreground">
            <span className="truncate">{label}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
          </span>
          {desc && <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>}
        </span>
      </Link>

      {children.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/40 pt-3">
          {children.map((c) => (
            <Link
              key={c.id}
              to={c.to!}
              className="rounded-md bg-white/[0.03] px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tNav(t, 'items', c.label)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
