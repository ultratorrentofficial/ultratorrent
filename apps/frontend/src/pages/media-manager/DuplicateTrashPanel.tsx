import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/**
 * What the Duplicate Center has sent to Trash, and how to get it back.
 *
 * The list is the resolution JOURNAL joined to live Trash entries, not the Trash
 * table alone. That matters after the retention window passes: the journal outlives
 * the Trash entry, so a purged file still appears with an explicit "no longer in
 * Trash" state rather than silently vanishing from the history — an operator asking
 * "what happened to that file?" gets an answer either way.
 *
 * Restore goes through the existing `/files/trash/restore` route rather than a
 * duplicate of it.
 */
export function DuplicateTrashPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicates', 'trash'],
    queryFn: () => api.media.duplicateTrashHistory(),
  });

  const restore = useMutation({
    mutationFn: (trashItemId: string) => api.files.trash.restore(trashItemId),
    onSuccess: () => {
      toast.success(t('duplicates.trash.restored'));
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
    },
    onError: (err) =>
      toast.error(t('duplicates.trash.restoreFailed'), err instanceof ApiError ? err.message : undefined),
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('duplicates.trash.loadError')} onRetry={() => void refetch()} />;

  const rows = data ?? [];
  if (!rows.length) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<Trash2 className="h-6 w-6" />}
            title={t('duplicates.trash.empty')}
            description={t('duplicates.trash.emptyBody')}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t('duplicates.trash.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('duplicates.trash.subtitle')}</p>
      </div>

      {rows.map((r) => (
        <Card key={r.actionId}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-xs">{r.originalPath}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {t('duplicates.trash.removedAt')} {formatDateTime(r.removedAt)}
                </span>
                {r.size != null ? <span>{formatBytes(r.size)}</span> : null}
                {r.actionType === 'trash_sidecar' ? (
                  <Badge variant="secondary">{t('duplicates.cleanup.sidecar')}</Badge>
                ) : null}
              </p>
            </div>
            {r.restorable && r.trashItemId ? (
              <Button
                variant="outline"
                size="sm"
                loading={restore.isPending}
                onClick={() => restore.mutate(r.trashItemId!)}
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t('duplicates.trash.restore')}
              </Button>
            ) : (
              <div className="text-right">
                <Badge variant="secondary">{t('duplicates.trash.purged')}</Badge>
                <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                  {t('duplicates.trash.purgedHint')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
