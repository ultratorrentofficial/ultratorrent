import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { ApiError, api, type DuplicateResolutionPreview } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Preview-then-confirm for a duplicate cleanup.
 *
 * The dialog never builds a plan itself. It asks the server for one, shows exactly
 * that, and sends back only the `resolutionId` — so what executes is what the operator
 * read, and a client cannot hand-craft a list of files to delete. The server pins the
 * plan to the group version and re-checks every path before touching it; if the group
 * changed in between, confirming fails loudly rather than acting on a stale plan.
 */
export function DuplicateCleanupDialog({
  groupId,
  keepItemId,
  open,
  onClose,
}: {
  groupId: string;
  keepItemId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<DuplicateResolutionPreview | null>(null);

  const preview = useMutation({
    mutationFn: () => api.media.previewDuplicateCleanup(groupId, keepItemId),
    onSuccess: setPlan,
    onError: (err) => {
      toast.error(t('duplicates.cleanup.previewFailed'), err instanceof ApiError ? err.message : undefined);
      onClose();
    },
  });

  const resolve = useMutation({
    mutationFn: () => api.media.resolveDuplicateCleanup(plan!.resolutionId),
    onSuccess: (r) => {
      // Partial is reported as partial. An HTTP 200 carrying failures shown as "done"
      // is how an operator learns to distrust the tool.
      if (r.status === 'completed') {
        toast.success(
          t('duplicates.cleanup.doneTitle'),
          t('duplicates.cleanup.doneBody', { count: r.trashed, size: formatBytes(r.reclaimedBytes) }),
        );
      } else {
        toast.error(
          t('duplicates.cleanup.partialTitle'),
          t('duplicates.cleanup.partialBody', { trashed: r.trashed, skipped: r.skipped, failed: r.failed }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
      onClose();
    },
    onError: (err) =>
      toast.error(t('duplicates.cleanup.failed'), err instanceof ApiError ? err.message : undefined),
  });

  // Build the plan as the dialog opens, so the operator never sees a stale one.
  if (open && !plan && !preview.isPending && !preview.isError) preview.mutate();
  if (!open && plan) setPlan(null);

  const blocked = (plan?.blockers.length ?? 0) > 0;

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} title={t('duplicates.cleanup.title')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('duplicates.cleanup.title')}</DialogTitle>
        <DialogDescription>{t('duplicates.cleanup.description')}</DialogDescription>
      </DialogHeader>

      <div className="max-h-[55vh] overflow-y-auto scrollbar-thin">

        {preview.isPending || !plan ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('duplicates.cleanup.building')}</p>
        ) : (
          <div className="space-y-4 text-sm">
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('duplicates.cleanup.keeping')}
              </h4>
              <p className="break-all font-mono text-xs">{plan.keepPath}</p>
            </section>

            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('duplicates.cleanup.toTrash', { count: plan.actions.length })}
              </h4>
              <ul className="space-y-1">
                {plan.actions.map((a) => (
                  <li key={a.sourcePath} className="flex items-start gap-2">
                    <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">{a.sourcePath}</span>
                    {a.actionType === 'trash_sidecar' ? (
                      <Badge variant="secondary">{t('duplicates.cleanup.sidecar')}</Badge>
                    ) : null}
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.fileSize)}</span>
                  </li>
                ))}
              </ul>
            </section>

            {plan.orphanedSubtitles.length ? (
              <section className="rounded border border-warning/40 bg-warning/5 p-3">
                <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('duplicates.cleanup.orphanedSubs')}
                </h4>
                <p className="mb-2 text-xs text-muted-foreground">{t('duplicates.cleanup.orphanedSubsHint')}</p>
                <ul className="space-y-0.5">
                  {plan.orphanedSubtitles.map((o) => (
                    <li key={o.path} className="break-all font-mono text-xs">
                      {o.path}
                      {o.language ? ` (${o.language})` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {blocked ? (
              <section className="rounded border border-destructive/40 bg-destructive/5 p-3">
                <h4 className="mb-1 text-xs font-semibold text-destructive">{t('duplicates.cleanup.blocked')}</h4>
                <ul className="space-y-0.5 text-xs">
                  {plan.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {t('duplicates.cleanup.reclaim', { size: formatBytes(plan.expectedSavingsBytes) })}
            </p>
            {/* The one thing that most reduces fear of the button. */}
            <p className="text-xs text-muted-foreground">{t('duplicates.cleanup.trashNote')}</p>
          </div>
        )}

      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('duplicates.cleanup.cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={!plan || blocked || !plan.actions.length}
          loading={resolve.isPending}
          onClick={() => resolve.mutate()}
        >
          <Trash2 className="h-4 w-4" /> {t('duplicates.cleanup.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
