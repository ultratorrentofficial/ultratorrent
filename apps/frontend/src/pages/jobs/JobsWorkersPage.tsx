import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

/** Honest single in-process worker view (no fabricated pool/capacity). */
export function JobsWorkersPage() {
  const { t } = useTranslation('jobs');
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['jobs', 'workers'], queryFn: () => api.jobs.workers(), refetchInterval: 10000 });

  if (isLoading) return <CenteredSpinner label={t('workers.title')} />;
  if (isError || !data) return <ErrorState message={t('workers.title')} onRetry={() => refetch()} />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('workers.note')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.map((w) => (
          <Card key={w.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{w.id}</span>
                <Badge variant={w.status === 'online' ? 'success' : w.status === 'lost' ? 'destructive' : 'warning'} dot>
                  {w.status}
                </Badge>
              </div>
              <dl className="space-y-1 text-sm">
                <Row label={t('workers.host')} value={w.host} />
                <Row label={t('workers.started')} value={new Date(w.startedAt).toLocaleString()} />
                <Row label={t('workers.running')} value={String(w.runningJobs)} />
                <Row label={t('workers.capacity')} value={w.capacity == null ? t('workers.unbounded') : String(w.capacity)} />
                {w.version && <Row label={t('workers.version')} value={w.version} />}
                {w.inProcess && <Row label={t('workers.status')} value={t('workers.inProcess')} />}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}
