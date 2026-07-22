import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { api, ApiError, type CleanupRun } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { usePermission } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { CleanupHeader, StatusBadge, toNum } from './_shared';

const ACTIVE = new Set(['queued', 'running']);

export function CleanupRunsPage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canCancel = usePermission(PERMISSIONS.LIBRARY_CLEANUP_CANCEL);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cleanup', 'runs', 'list', page],
    queryFn: () => api.cleanup.listRuns({ page, pageSize: 25 }),
    placeholderData: keepPreviousData,
    // A run scans in the background; keep the list fresh while one is active.
    refetchInterval: (q) => (q.state.data?.items ?? []).some((r: CleanupRun) => ACTIVE.has(r.status)) ? 3000 : false,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.cleanup.cancelRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cleanup', 'runs'] }),
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('common.loadError')} onRetry={() => refetch()} />;

  const rows = data?.items ?? [];

  return (
    <div className="space-y-4">
      <CleanupHeader title={t('runs.title')} subtitle={t('runs.subtitle')} />

      {rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<Gauge className="h-6 w-6" />} title={t('runs.empty')} description={t('runs.emptyDesc')} />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('runs.col.trigger')}</TableHead>
                <TableHead>{t('runs.col.status')}</TableHead>
                <TableHead className="text-right">{t('runs.col.scanned')}</TableHead>
                <TableHead className="text-right">{t('runs.col.eligible')}</TableHead>
                <TableHead className="text-right">{t('runs.col.excluded')}</TableHead>
                <TableHead className="text-right">{t('runs.col.reclaimable')}</TableHead>
                <TableHead>{t('runs.col.started')}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">
                    {r.trigger}{r.simulate && <span className="ml-1 text-xs text-muted-foreground">(sim)</span>}
                  </TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{r.filesScanned}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{r.candidatesEligible}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{r.candidatesExcluded}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(toNum(r.estimatedReclaimBytes))}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.startedAt ? formatRelativeTime(r.startedAt) : '—'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      {r.candidatesEligible + r.candidatesExcluded > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => navigate(`/media/cleanup/runs/${r.id}`)}>
                          {t('runs.viewCandidates')}
                        </Button>
                      )}
                      {canCancel && ACTIVE.has(r.status) && (
                        <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>{t('runs.cancel')}</Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      <Pagination page={page} pageSize={25} total={data?.total ?? 0} onPage={setPage} />
    </div>
  );
}
