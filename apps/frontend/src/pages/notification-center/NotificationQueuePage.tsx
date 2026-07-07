import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  queued: 'secondary', sending: 'default', retrying: 'secondary', throttled: 'outline',
};

export function NotificationQueuePage() {
  const { t } = useTranslation('notificationCenter');
  const q = useQuery({ queryKey: ['nc', 'queue'], queryFn: () => api.notificationCenter.queue({ pageSize: 50 }), refetchInterval: 5000 });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('queue.loadError')} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('queue.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('queue.subtitle', { total: q.data.total })}</p>
      </div>
      {q.data.items.length === 0 ? (
        <EmptyState title={t('queue.empty')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('history.status')}</TableHead>
                  <TableHead>{t('history.event')}</TableHead>
                  <TableHead>{t('history.provider')}</TableHead>
                  <TableHead>{t('queue.attempts')}</TableHead>
                  <TableHead>{t('history.when')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{t(`status.${r.status}`, { defaultValue: r.status })}</Badge></TableCell>
                    <TableCell className="font-medium">{r.event}</TableCell>
                    <TableCell>{r.provider}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.attempts}/{r.maxAttempts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
