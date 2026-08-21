import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from './ConfirmDialog';
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
  /*
   * Restore and purge both ask before acting, and only one can be open at a
   * time — so the row travels with the question rather than living in three
   * booleans that could disagree.
   */
  const [confirming, setConfirming] = useState<
    { item: { id: string; originalPath?: string | null }; act: 'restore' | 'purge' } | null
  >(null);

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
                          onClick={() => setConfirming({ item: q, act: 'restore' })}
                        >
                          {t('quarantine.restore')}
                        </Button>
                      )}
                      {/* Permanent deletion from quarantine — the most destructive
                          control in the module, and it was styled as plain text. */}
                      {canPurge && (
                        <Button
                          size="sm" variant="destructive"
                          onClick={() => setConfirming({ item: q, act: 'purge' })}
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

      {confirming && (
        <ConfirmDialog
          open
          destructive={confirming.act === 'purge'}
          busy={restore.isPending || purge.isPending}
          title={t(`quarantine.${confirming.act}` as 'quarantine.restore')}
          body={t(
            confirming.act === 'purge' ? 'quarantine.confirmPurge' : 'quarantine.confirmRestore',
          )}
          /*
           * A checkbox, not a second confirm. The old flow asked "overwrite?" in
           * another dialog whose Cancel meant "restore without overwriting" —
           * the most obvious reading of that button was the wrong one.
           */
          checkbox={
            confirming.act === 'restore' ? { label: t('quarantine.overwrite') } : undefined
          }
          confirmLabel={t(`quarantine.${confirming.act}` as 'quarantine.restore')}
          onClose={() => setConfirming(null)}
          onConfirm={({ checked }) => {
            const { item, act } = confirming;
            if (act === 'purge') purge.mutate(item.id);
            else restore.mutate({ id: item.id, overwrite: checked });
            setConfirming(null);
          }}
        />
      )}

      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} />
    </div>
  );
}
