import { useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { api, type RenameRun } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { RenameRunDetail } from './RenameRunDetail';

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
  /*
   * Which run is expanded. One at a time: these lists are long and the point of
   * expanding is to study one run, not to compare six.
   */
  const [openRun, setOpenRun] = useState<string | null>(null);

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
          runs.data.map((run: RenameRun) => {
            const open = openRun === run.runId;
            return (
              <div key={run.runId} className="rounded-lg border border-white/10">
                <div className="flex items-center gap-3 px-3 py-2">
                  {/*
                   * The row itself expands. Undoing was the only thing this list
                   * could do, so the decision behind it — what actually changed —
                   * had to be made blind.
                   */}
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => setOpenRun(open ? null : run.runId)}
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm">
                        {t('rename.undo.run', {
                          count: run.operations,
                          when: formatDateTime(run.at),
                        })}
                      </span>
                      <span className="block text-xs text-muted-foreground">{run.mode}</span>
                    </span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={undo.isPending}
                    onClick={() => undo.mutate(run.runId)}
                  >
                    {t('rename.undo.button')}
                  </Button>
                </div>
                {/* Fetched only when opened — a list of runs must not fetch every
                    run's file list to render. */}
                {open && <RenameRunDetail runId={run.runId} />}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
