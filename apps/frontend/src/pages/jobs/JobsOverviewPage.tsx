import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle2, Clock, Loader2, TriangleAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from './jobStatus';
import type { PlatformJobStatus } from '@/lib/api';

/**
 * Jobs Center overview — real, RBAC-scoped metrics from `/api/jobs/overview`
 * (no fabricated numbers). Polls so figures stay live without a refresh.
 */
export function JobsOverviewPage() {
  const { t } = useTranslation('jobs');
  const td = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['jobs', 'overview'],
    queryFn: () => api.jobs.overview(),
    refetchInterval: 5000,
  });

  if (isLoading) return <CenteredSpinner label={t('overview.title')} />;
  if (isError || !data) return <ErrorState message={t('empty.hint')} onRetry={() => refetch()} />;

  const cards: { key: string; value: number | string; icon: typeof Activity; to?: string; tone?: string }[] = [
    { key: 'running', value: data.running, icon: Loader2, to: '/jobs/list?status=running', tone: 'text-info' },
    { key: 'queued', value: data.queued, icon: Clock, to: '/jobs/list?status=queued' },
    { key: 'waiting', value: data.waiting, icon: Clock, to: '/jobs/list?status=waiting' },
    { key: 'scheduled', value: data.scheduled, icon: Clock, to: '/jobs/list?status=scheduled' },
    { key: 'failed', value: data.failed, icon: XCircle, to: '/jobs/list?status=failed', tone: 'text-destructive' },
    { key: 'active', value: data.active, icon: Activity, to: '/jobs/list' },
    { key: 'completedToday', value: data.completedToday, icon: CheckCircle2, tone: 'text-success' },
    { key: 'failedToday', value: data.failedToday, icon: TriangleAlert, tone: 'text-destructive' },
    { key: 'successRate', value: data.successRate == null ? '—' : `${data.successRate}%`, icon: Activity },
  ];

  const byStatus = Object.entries(data.byStatus).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => {
          const Icon = c.icon;
          const body = (
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardContent className="flex flex-col gap-1 p-4">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className={`h-3.5 w-3.5 ${c.tone ?? ''}`} />
                  {td(`overview.${c.key}`)}
                </span>
                <span className="text-2xl font-bold tabular-nums">{c.value}</span>
              </CardContent>
            </Card>
          );
          return c.to ? (
            <Link key={c.key} to={c.to} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
              {body}
            </Link>
          ) : (
            <div key={c.key}>{body}</div>
          );
        })}
      </div>

      {byStatus.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('overview.byStatus')}</h2>
            <div className="flex flex-wrap gap-2">
              {byStatus.map(([status, count]) => (
                <Link key={status} to={`/jobs/list?status=${status}`}>
                  <Badge variant={statusVariant(status as PlatformJobStatus)}>
                    {td(`status.${status}`)} · {count}
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
