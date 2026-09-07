import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, type DiscoveryRemovalScope, type DiscoveryTorrentAction } from '@/lib/api';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/ui/toast';

/**
 * Removing several discovered titles at once.
 *
 * Same three escalating scopes as the single-title dialog, and the same default:
 * catalogue only. What it deliberately does NOT do is show a per-title plan.
 *
 * Forty plans is not something anybody reads, and rendering one would imply a
 * review that is not happening — so the dialog states the rules that hold for
 * every title instead, which are the same rules the single-title plan enumerates:
 * files are matched by external id only, hand-edited rules are never touched, and
 * media goes to Trash. Somebody who wants the per-title detail removes that title
 * on its own, where the plan is shown.
 */

const SCOPES: DiscoveryRemovalScope[] = ['catalog', 'monitoring', 'library'];

export function BulkRemoveDialog({
  ids,
  onClose,
  onRemoved,
}: {
  ids: string[];
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const [scope, setScope] = useState<DiscoveryRemovalScope>('catalog');
  const [removeTorrent, setRemoveTorrent] = useState(false);

  const remove = useMutation({
    mutationFn: () =>
      api.mediaDiscovery.bulkRemoveItems({
        ids,
        scope,
        torrentAction: (scope === 'library' && removeTorrent
          ? 'stop_and_delete'
          : 'keep') as DiscoveryTorrentAction,
      }),
    onSuccess: (result) => {
      toast.success(t('bulk.done', { count: result.removed.length }));
      /*
       * Partial success is reported as partial. A bulk action that says
       * "removed 40" when four failed is worse than one that failed outright,
       * because nothing prompts anybody to look.
       */
      if (result.failed.length) {
        toast.error(t('bulk.someFailed', { count: result.failed.length }));
      }
      if (result.libraryItems) {
        toast.info(t('bulk.libraryItems', { count: result.libraryItems }));
      }
      result.skipped.slice(0, 5).forEach((reason) => toast.info(reason));
      onRemoved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onClose={onClose} title={t('bulk.title', { count: ids.length })}>
      <DialogHeader>
        <DialogTitle>{t('bulk.title', { count: ids.length })}</DialogTitle>
      </DialogHeader>

      <div className="space-y-3">
        {SCOPES.map((id) => (
          <label
            key={id}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
              scope === id ? 'border-primary/60 bg-primary/5' : 'border-white/10 hover:border-white/20'
            }`}
          >
            <input
              type="radio"
              name="discovery-bulk-scope"
              className="mt-1"
              checked={scope === id}
              onChange={() => setScope(id)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t(`remove.scope.${id}.label`)}</p>
              <p className="text-xs text-muted-foreground">
                {t(`bulk.scope.${id}`, { count: ids.length })}
              </p>
            </div>
          </label>
        ))}

        {scope === 'library' && (
          <>
            <label className="flex items-center gap-2 pl-3 text-xs">
              <Checkbox checked={removeTorrent} onCheckedChange={(v) => setRemoveTorrent(Boolean(v))} />
              {t('remove.alsoTorrent')}
            </label>
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('bulk.libraryWarning', { count: ids.length })}
            </p>
          </>
        )}

        <p className="text-xs text-muted-foreground">{t('bulk.rules')}</p>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
            {t('remove.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('bulk.confirm', { count: ids.length })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
