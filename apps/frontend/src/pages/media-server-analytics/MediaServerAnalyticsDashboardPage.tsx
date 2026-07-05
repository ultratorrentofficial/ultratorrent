import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  online: 'success',
  offline: 'destructive',
  unknown: 'secondary',
};

function Widget({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className={`text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{formatNumber(value)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export function MediaServerAnalyticsDashboardPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({ queryKey: ['mediaServerAnalytics', 'dashboard'], queryFn: () => api.mediaServerAnalytics.dashboard() });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('dashboard.loadError')} onRetry={() => void q.refetch()} />;

  const d = q.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Widget label={t('dashboard.widget.total')} value={d.servers.total} />
        <Widget label={t('dashboard.widget.enabled')} value={d.servers.enabled} />
        <Widget label={t('dashboard.widget.online')} value={d.servers.online} tone="text-success" />
        <Widget label={t('dashboard.widget.offline')} value={d.servers.offline} tone="text-destructive" />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t('dashboard.connections')}</h2>
        {d.connections.length === 0 ? (
          <EmptyState title={t('dashboard.noConnections')} />
        ) : (
          <ul className="divide-y divide-white/5 rounded-md border border-white/5">
            {d.connections.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium">{c.name}</span>
                <span className="text-xs uppercase text-muted-foreground">{c.kind}</span>
                <span className="flex-1" />
                {c.serverVersion && <span className="text-xs text-muted-foreground">{c.serverVersion}</span>}
                <Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>
                  {t(`connections.status.${c.status}`, { defaultValue: c.status })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
