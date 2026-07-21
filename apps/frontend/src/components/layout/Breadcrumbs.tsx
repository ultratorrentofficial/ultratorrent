import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { NAV_GROUPS, tNav } from '@/components/layout/navigation';
import { useBreadcrumbEntityLabel } from '@/components/layout/BreadcrumbContext';

export interface Crumb {
  label: string;
  to?: string;
}

/** Detail routes that aren't in the sidebar but should still get a trail. */
const DETAIL_LABELS: { prefix: string; label: string }[] = [
  { prefix: '/account', label: 'Account' },
  { prefix: '/rss/rules/', label: 'Rule' },
  { prefix: '/rss/feeds/', label: 'History' },
  { prefix: '/media/items/', label: 'Details' },
];

interface FlatEntry {
  group: string;
  parent?: string;
  label: string;
  base: string;
  parentBase?: string;
}

/** Flatten NAV_GROUPS (incl. nested children) into path-matchable entries. */
function flatEntries(): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.to) out.push({ group: group.title, label: item.label, base: item.to.split('?')[0] });
      for (const child of item.children ?? []) {
        if (child.to) {
          out.push({
            group: group.title,
            parent: item.label,
            parentBase: item.to?.split('?')[0],
            label: child.label,
            base: child.to.split('?')[0],
          });
        }
      }
    }
  }
  return out;
}

/**
 * Build a breadcrumb trail for a pathname by matching it against the navigation
 * information architecture (`NAV_GROUPS`, including nested sub-menus). Returns
 * `Group › [Parent ›] Item [› Detail]`. Exported for tests.
 */
export function crumbsFor(pathname: string): Crumb[] {
  // A domain landing hub (`/hub/:domainId`) is the domain itself.
  if (pathname.startsWith('/hub/')) {
    const group = NAV_GROUPS.find((g) => g.id === pathname.split('/')[2]);
    if (group) return [{ label: group.title }];
  }

  let best: FlatEntry | null = null;
  for (const entry of flatEntries()) {
    if (pathname === entry.base || pathname.startsWith(entry.base + '/')) {
      if (!best || entry.base.length > best.base.length) best = entry;
    }
  }

  if (!best) {
    // Not in the nav (e.g. /account detail) — derive a single crumb from the path.
    const detail = DETAIL_LABELS.find((d) => pathname.startsWith(d.prefix));
    if (detail) return [{ label: detail.label }];
    const seg = pathname.split('/').filter(Boolean)[0];
    if (!seg) return [];
    return [{ label: seg.charAt(0).toUpperCase() + seg.slice(1) }];
  }

  const crumbs: Crumb[] = [{ label: best.group }];
  if (best.parent && best.parentBase) crumbs.push({ label: best.parent, to: best.parentBase });
  crumbs.push({ label: best.label, to: best.base });

  // Deeper than the matched nav route → a detail page.
  if (pathname.length > best.base.length) {
    const detail = DETAIL_LABELS.find((d) => pathname.startsWith(d.prefix));
    crumbs.push({ label: detail?.label ?? 'Details' });
  }
  return crumbs;
}

/** App-level breadcrumb trail rendered in the top bar. */
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const { t, i18n } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const crumbs = crumbsFor(pathname);
  // A detail page can name its entity so the trail ends with e.g. the item title
  // instead of a generic "Details".
  const entityLabel = useBreadcrumbEntityLabel(pathname);
  if (crumbs.length === 0) return null;

  // `crumbsFor` returns canonical English (tests assert on it); translate at
  // render by matching the label against the nav sections, English as fallback.
  const label = (raw: string): string => {
    for (const section of ['items', 'groups', 'details'] as const) {
      if (i18n.exists(`${section}.${raw}`, { ns: 'nav' })) return tNav(t, section, raw);
    }
    return raw;
  };

  return (
    <nav aria-label={tShell('nav.breadcrumb')} className="hidden min-w-0 items-center sm:flex">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          const text = last && entityLabel ? entityLabel : label(crumb.label);
          return (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
              {crumb.to && !last ? (
                <Link
                  to={crumb.to}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {text}
                </Link>
              ) : (
                <span
                  className={
                    last ? 'truncate font-medium text-foreground' : 'truncate text-muted-foreground'
                  }
                  aria-current={last ? 'page' : undefined}
                >
                  {text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
