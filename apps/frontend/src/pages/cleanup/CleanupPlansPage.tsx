import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck } from 'lucide-react';
import { api, ApiError, type CleanupPlan } from '@/lib/api';
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
import { CleanupHeader, StatusBadge, toNum } from './_shared';
import { PlanActionsDialog } from './PlanActionsDialog';

const ACTIVE = new Set(['executing']);

export function CleanupPlansPage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const canApprove = usePermission(PERMISSIONS.LIBRARY_CLEANUP_APPROVE);
  const canTrash = usePermission(PERMISSIONS.LIBRARY_CLEANUP_TRASH);
  const canDelete = usePermission(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  const canCancel = usePermission(PERMISSIONS.LIBRARY_CLEANUP_CANCEL);

  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cleanup', 'plans', 'list', page],
    queryFn: () => api.cleanup.listPlans({ page, pageSize: 25 }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items ?? []).some((p: CleanupPlan) => ACTIVE.has(p.status)) ? 2000 : false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cleanup', 'plans'] });
  const onErr = (e: unknown) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined);

  const approve = useMutation({ mutationFn: (id: string) => api.cleanup.approvePlan(id), onSuccess: () => invalidate(), onError: onErr });
  const reject = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.cleanup.rejectPlan(v.id, v.reason), onSuccess: () => invalidate(), onError: onErr });
  const cancel = useMutation({ mutationFn: (id: string) => api.cleanup.cancelPlan(id), onSuccess: () => invalidate(), onError: onErr });
  const execute = useMutation({
    mutationFn: (id: string) => api.cleanup.executePlan(id),
    onSuccess: (r) => { toast.success(t('plans.executed', { completed: r.completed, skipped: r.skipped, failed: r.failed })); invalidate(); },
    onError: onErr,
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('common.loadError')} onRetry={() => refetch()} />;

  const rows = data?.items ?? [];
  // The destination permission is the second approval gate: someone who can approve
  // a quarantine cannot thereby approve a permanent removal.
  const mayActOn = (p: CleanupPlan) => p.action === 'permanent_delete' ? canDelete : canTrash;

  return (
    <div className="space-y-4">
      <CleanupHeader title={t('plans.title')} subtitle={t('plans.subtitle')} />

      {rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title={t('plans.empty')} description={t('plans.emptyDesc')} />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('plans.col.destination')}</TableHead>
                <TableHead>{t('plans.col.status')}</TableHead>
                <TableHead className="text-right">{t('plans.col.files')}</TableHead>
                <TableHead className="text-right">{t('plans.col.reclaimable')}</TableHead>
                <TableHead>{t('plans.col.expires')}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-sm">{t(`destination.${p.action}`, { defaultValue: p.action })}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{p.candidateCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(toNum(p.estimatedReclaimBytes))}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.status === 'pending_approval' && p.expiresAt ? formatRelativeTime(p.expiresAt) : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(p.id)}>{t('plans.action.viewActions')}</Button>
                      {canApprove && p.status === 'pending_approval' && (
                        <>
                          <Button
                            size="sm" variant="secondary" disabled={!mayActOn(p) || approve.isPending}
                            onClick={() => { if (window.confirm(t('plans.confirmApprove', { destination: t(`destination.${p.action}`, { defaultValue: p.action }) }))) approve.mutate(p.id); }}
                          >
                            {t('plans.action.approve')}
                          </Button>
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => { const reason = window.prompt(t('plans.rejectReason')); if (reason) reject.mutate({ id: p.id, reason }); }}
                          >
                            {t('plans.action.reject')}
                          </Button>
                        </>
                      )}
                      {p.status === 'approved' && mayActOn(p) && (
                        <Button
                          size="sm" variant="secondary" loading={execute.isPending && execute.variables === p.id}
                          onClick={() => { if (window.confirm(t('plans.confirmExecute'))) execute.mutate(p.id); }}
                        >
                          {t('plans.action.execute')}
                        </Button>
                      )}
                      {canCancel && (p.status === 'pending_approval' || p.status === 'approved') && (
                        <Button size="sm" variant="ghost" onClick={() => cancel.mutate(p.id)}>{t('plans.action.cancel')}</Button>
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
      {viewing && <PlanActionsDialog planId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
