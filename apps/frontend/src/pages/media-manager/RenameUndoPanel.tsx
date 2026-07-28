import { formatDateTime } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { api, type RenameRun } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Skeleton } from '@/components/ui/feedback';

/**
 * Reverse a rename run.
 *
 * The list is of **runs**, not files: an apply is one operator action, and
 * undoing half of it would leave a library in a state nobody chose.
 *
 * A run is identified by id and nothing else crosses the wire — the server
 * reverses what it recorded, so the client cannot direct a move by naming
 * paths of its own.
 */
export function RenameUndoPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const qc = useQueryClient();

  const runs = useQuery({
    queryKey: ['media', 'rename', 'undoable'],
    queryFn: api.media.undoableRenameRuns,
  });

  const undo = useMutation({
    mutationFn: (runId: string) => api.media.undoRename(runId),
    onSuccess: (result) => {
      toast.success(t('rename.undo.done', { count: result.undone }));
      // Partial reversals are surfaced, not folded into the success line: the
      // library is now in a state the operator did not fully choose, and they
      // need to know which files stayed put and why.
      if (result.skipped.length) {
        const reasons = [...new Set(result.skipped.map((s) => s.reason))]
          .map((r) => t(`rename.undo.reason.${r}` as 'rename.undo.reason.moved_since'))
          .join(' · ');
        toast.error(`${t('rename.undo.partial', { skipped: result.skipped.length })} ${reasons}`);
      }
      qc.invalidateQueries({ queryKey: ['media', 'rename', 'undoable'] });
      qc.invalidateQueries({ queryKey: ['library-browser'] });
    },
    onError: (e: Error) => toast.error(e?.message || t('rename.undo.failed')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Undo2 className="h-4 w-4" aria-hidden />
          {t('rename.undo.title')}
        </CardTitle>
        <CardDescription>{t('rename.undo.confirm')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !runs.data?.length ? (
          <EmptyState title={t('rename.undo.none')} />
        ) : (
          runs.data.map((run: RenameRun) => (
            <div
              key={run.runId}
              className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {t('rename.undo.run', {
                    count: run.operations,
                    when: formatDateTime(run.at),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">{run.mode}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={undo.isPending}
                onClick={() => undo.mutate(run.runId)}
              >
                {t('rename.undo.button')}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
