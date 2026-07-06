import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  sent: 'default', delivered: 'default', failed: 'destructive', queued: 'secondary', retrying: 'secondary', throttled: 'outline', skipped: 'outline', cancelled: 'outline',
};

export function NotificationHistoryPage() {
  const { t } = useTranslation('notificationCenter');
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['nc', 'history', page], queryFn: () => api.notificationCenter.history({ page, pageSize: 25 }), refetchInterval: 15000 });
  const retry = useMutation({ mutationFn: (id: string) => api.notificationCenter.retry(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ['nc', 'history'] }) });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('history.loadError')} onRetry={() => void q.refetch()} />;
  const { items, total, pageSize } = q.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('history.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('history.subtitle')}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState title={t('history.empty')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('history.status')}</TableHead>
                  <TableHead>{t('history.event')}</TableHead>
                  <TableHead>{t('history.provider')}</TableHead>
                  <TableHead>{t('history.destination')}</TableHead>
                  <TableHead>{t('history.when')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{t(`status.${r.status}`, { defaultValue: r.status })}</Badge></TableCell>
                    <TableCell className="font-medium">{r.event}</TableCell>
                    <TableCell>{r.provider}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.destination ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {r.status === 'failed' && <Button variant="ghost" size="sm" onClick={() => retry.mutate(r.id)}><RotateCw className="h-3.5 w-3.5" />{t('history.retry')}</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('history.prev')}</Button>
          <span className="text-sm text-muted-foreground">{t('history.pageOf', { page, pages })}</span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t('history.next')}</Button>
        </div>
      )}
    </div>
  );
}
