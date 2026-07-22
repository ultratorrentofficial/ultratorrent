import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { usePermission } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { CleanupHeader, toNum } from './_shared';

export function CleanupQuarantinePage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const canRestore = usePermission(PERMISSIONS.LIBRARY_CLEANUP_RESTORE);
  const canPurge = usePermission(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cleanup', 'quarantine', 'list', page],
    queryFn: () => api.cleanup.listQuarantine({ page, pageSize: 50, status: 'quarantined' }),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cleanup', 'quarantine'] });
  const onErr = (e: unknown) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined);

  const restore = useMutation({ mutationFn: (v: { id: string; overwrite: boolean }) => api.cleanup.restoreQuarantine(v.id, v.overwrite), onSuccess: () => invalidate(), onError: onErr });
  const purge = useMutation({ mutationFn: (id: string) => api.cleanup.purgeQuarantine(id), onSuccess: () => invalidate(), onError: onErr });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('common.loadError')} onRetry={() => refetch()} />;

  const rows = data?.items ?? [];

  return (
    <div className="space-y-4">
      <CleanupHeader title={t('quarantine.title')} subtitle={t('quarantine.subtitle')} />

      {rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<Trash2 className="h-6 w-6" />} title={t('quarantine.empty')} description={t('quarantine.emptyDesc')} />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quarantine.col.path')}</TableHead>
                <TableHead className="text-right">{t('quarantine.col.size')}</TableHead>
                <TableHead>{t('quarantine.col.deadline')}</TableHead>
                <TableHead>{t('quarantine.col.quarantined')}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((q) => (
                <TableRow key={q.id}>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={q.originalPath}>{q.originalPath}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(toNum(q.fileSizeBytes))}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{q.restoreDeadline ? formatRelativeTime(q.restoreDeadline) : '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatRelativeTime(q.quarantinedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      {canRestore && (
                        <Button
                          size="sm" variant="secondary"
                          onClick={() => {
                            if (!window.confirm(t('quarantine.confirmRestore'))) return;
                            const overwrite = window.confirm(t('quarantine.overwrite'));
                            restore.mutate({ id: q.id, overwrite });
                          }}
                        >
                          {t('quarantine.restore')}
                        </Button>
                      )}
                      {canPurge && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => { if (window.confirm(t('quarantine.confirmPurge'))) purge.mutate(q.id); }}
                        >
                          {t('quarantine.purge')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} />
    </div>
  );
}
