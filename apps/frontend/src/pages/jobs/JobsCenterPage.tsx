import { Link, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { JOB_TABS } from './jobStatus';

/**
 * Jobs Center shell: the platform's operational control plane. A header + a
 * status tab strip (Overview + the per-status views), then the active view via
 * `<Outlet/>`. The status views are one shared list component filtered by query
 * param (route-driven), never duplicated per status.
 */
export function JobsCenterPage() {
  const { t } = useTranslation('jobs');
  const td = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const activeStatus = params.get('status');
  const onList = pathname === '/jobs/list';
  const onOverview = pathname === '/jobs';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <nav
        aria-label={t('title')}
        className="flex items-center gap-1 overflow-x-auto border-b border-border/60 scrollbar-none"
      >
        <Tab to="/jobs" label={t('nav.overview')} active={onOverview} />
        {JOB_TABS.map((tab) => {
          const to = tab.status ? `/jobs/list?status=${tab.status}` : '/jobs/list';
          const active = onList && (tab.status ? activeStatus === tab.status : !activeStatus);
          return <Tab key={tab.key} to={to} label={td(`nav.${tab.key}`)} active={active} />;
        })}
      </nav>

      <Outlet />
    </div>
  );
}

function Tab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );
}
