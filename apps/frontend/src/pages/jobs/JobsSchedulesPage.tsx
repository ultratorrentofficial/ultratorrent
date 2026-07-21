import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** Human interval, e.g. 60000 → "60s", 3600000 → "60m". */
function fmtInterval(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

/** Read-only inventory of the platform's real scheduled tasks (no fake controls). */
export function JobsSchedulesPage() {
  const { t } = useTranslation('jobs');
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['jobs', 'schedules'], queryFn: () => api.jobs.schedules(), refetchInterval: 15000 });

  if (isLoading) return <CenteredSpinner label={t('schedules.title')} />;
  if (isError || !data) return <ErrorState message={t('schedules.empty')} onRetry={() => refetch()} />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('schedules.note')}</p>
      {data.length === 0 ? (
        <EmptyState title={t('schedules.empty')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('schedules.name')}</TableHead>
                    <TableHead>{t('schedules.module')}</TableHead>
                    <TableHead>{t('schedules.trigger')}</TableHead>
                    <TableHead>{t('schedules.interval')}</TableHead>
                    <TableHead>{t('schedules.enabled')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((s) => (
                    <TableRow key={s.name}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.module}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.triggerType}</TableCell>
                      <TableCell className="text-sm tabular-nums">{s.cron ?? fmtInterval(s.intervalMs)}</TableCell>
                      <TableCell>
                        <Badge variant={s.enabled ? 'success' : 'secondary'} dot>{String(s.enabled)}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
