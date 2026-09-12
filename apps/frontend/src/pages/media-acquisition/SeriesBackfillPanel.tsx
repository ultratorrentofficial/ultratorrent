import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type SeriesBackfillAction } from '@/lib/api';
import { usePermission } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { wsClient } from '@/lib/ws';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  queued: 'secondary',
  running: 'info',
  paused: 'warning',
  completed: 'success',
  completed_with_warnings: 'warning',
  failed: 'destructive',
  cancelled: 'secondary',
};

const ACTIVE = new Set(['queued', 'running', 'paused']);

/**
 * Compact status + controls for a series' back-catalogue search job. Shows
 * nothing until a backfill has run for the series; once one has, it renders
 * progress and (for watchlist-managers) pause/resume/cancel. Polls while a job
 * is active and refreshes on the backfill-completed WS event.
 */
export function SeriesBackfillPanel({ watchlistItemId }: { watchlistItemId: string }) {
  const { t } = useTranslation('seriesAcquisition');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = usePermission(PERMISSIONS.MEDIA_ACQUISITION_MANAGE_WATCHLIST);

  const qk = ['seriesAcquisition', 'backfill', watchlistItemId];
  const job = useQuery({
    queryKey: qk,
    queryFn: () => api.seriesAcquisition.backfillStatus(watchlistItemId),
    refetchInterval: (q) => (ACTIVE.has((q.state.data?.status ?? '') as string) ? 2000 : false),
  });

  useEffect(() => {
    const off = wsClient.on('media_acquisition.series.backfill_completed', (p) => {
      if (p.watchlistItemId === watchlistItemId) void queryClient.invalidateQueries({ queryKey: qk });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistItemId]);

  const control = useMutation({
    mutationFn: (action: SeriesBackfillAction) => {
      const id = job.data?.id;
      if (!id) throw new Error('no job');
      return api.seriesAcquisition.backfillControl(id, action).then(() => action);
    },
    onSuccess: (action) => {
      toast.success(t(`backfill.${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled'}`));
      void queryClient.invalidateQueries({ queryKey: qk });
    },
    onError: (err) => toast.error(t('backfill.actionFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const data = job.data;
  if (!data) return null;

  const total = data.progressTotal ?? 0;
  const current = data.progressCurrent ?? 0;
  const s = data.resultSummary ?? {};

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('backfill.title')}</span>
        <Badge variant={STATUS_VARIANT[data.status] ?? 'secondary'}>
          {t(`backfill.status.${data.status}`, { defaultValue: data.status })}
        </Badge>
      </div>

      {total > 0 && (
        <div className="mt-2">
          <Progress value={total ? current / total : 0} />
          <div className="mt-1 text-xs text-muted-foreground">
            {t('backfill.progress', { current, total })}
          </div>
        </div>
      )}

      {(data.status === 'completed' || data.status === 'completed_with_warnings') && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t('backfill.summary', {
            grabbed: s.grabbed ?? 0,
            pending: s.pendingApproval ?? 0,
            noResults: s.noResults ?? 0,
            failed: s.failed ?? 0,
          })}
        </div>
      )}

      {canManage && ACTIVE.has(data.status) && (
        <div className="mt-2 flex items-center gap-2">
          {data.status === 'paused' ? (
            <Button size="sm" variant="secondary" onClick={() => control.mutate('resume')} loading={control.isPending}>
              {t('backfill.resume')}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => control.mutate('pause')} loading={control.isPending}>
              {t('backfill.pause')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => control.mutate('cancel')} loading={control.isPending}>
            {t('backfill.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
