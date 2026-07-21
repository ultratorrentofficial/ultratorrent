import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  isBranchActive,
  isItemActive,
  resolveActiveContext,
  tNav,
  type NavItem,
} from '@/components/layout/navigation';
import { useVisibleNavGroups } from '@/components/layout/useVisibleNavGroups';
import { cn } from '@/lib/utils';

/**
 * Domain-aware secondary navigation: a horizontal strip of the sibling pages
 * within the active domain, so a user can move laterally without going back to
 * the sidebar (and can still navigate when the sidebar is hidden on mobile).
 * When the active page is a nested parent, a second row surfaces its sub-pages.
 *
 * It never introduces links the sidebar lacks — it's the same, already
 * RBAC/module-filtered nav data. Renders nothing when there's only one place to
 * go (a single-item domain, or a route outside the nav).
 */
export function ContextualSubNav() {
  const location = useLocation();
  const { t } = useTranslation('nav');
  const groups = useVisibleNavGroups();
  const ctx = resolveActiveContext(groups, location.pathname, location.search);
  if (!ctx) return null;

  // Only navigable siblings become tabs (a pure parent contributes its branch,
  // which we reach via its landing route or first child).
  const siblings = ctx.group.items.filter((i) => i.to || (i.children ?? []).some((c) => c.to));
  // The active top-level item's children (present only when we're in a branch).
  const branch = ctx.parent ?? (ctx.item.children?.length ? ctx.item : undefined);
  const children = (branch?.children ?? []).filter((c) => c.to);

  const hasSiblingRow = siblings.length > 1;
  const hasChildRow = children.length > 0;
  if (!hasSiblingRow && !hasChildRow) return null;

  const branchLabel = branch ? tNav(t, 'items', branch.label) : '';

  return (
    <nav
      aria-label={`${tNav(t, 'groups', ctx.group.title)} sections`}
      className="border-b border-border/60 bg-background/40 backdrop-blur-sm"
    >
      {hasSiblingRow && (
        <div className="flex items-center gap-1 overflow-x-auto px-4 scrollbar-none sm:px-6">
          {siblings.map((item) => (
            <SubNavTab key={item.id} item={item} label={tNav(t, 'items', item.label)} />
          ))}
        </div>
      )}
      {hasChildRow && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-border/40 bg-white/[0.015] px-4 py-1 scrollbar-none sm:px-6">
          <span className="mr-1 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {branchLabel}
          </span>
          {children.map((child) => (
            <SubNavChip key={child.id} item={child} label={tNav(t, 'items', child.label)} />
          ))}
        </div>
      )}
    </nav>
  );
}

/** A primary sibling tab (underline-active), used for the domain's top-level pages. */
function SubNavTab({ item, label }: { item: NavItem; label: string }) {
  const location = useLocation();
  const active = isBranchActive(item, location.pathname, location.search);
  const to = item.to ?? item.children?.find((c) => c.to)?.to ?? '#';
  const Icon = item.icon;
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}

/** A secondary sub-page chip (pill-active), used for a branch's children. */
function SubNavChip({ item, label }: { item: NavItem; label: string }) {
  const location = useLocation();
  const active = isItemActive(item, location.pathname, location.search);
  return (
    <Link
      to={item.to ?? '#'}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );
}
