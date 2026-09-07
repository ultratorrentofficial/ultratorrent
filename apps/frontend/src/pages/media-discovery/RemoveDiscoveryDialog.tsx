import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  api,
  type DiscoveredMediaItem,
  type DiscoveryRemovalScope,
  type DiscoveryTorrentAction,
} from '@/lib/api';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Removing a discovered title.
 *
 * The whole reason this is a dialog and not a confirm() is that "remove this
 * show" means three different things, and the most destructive one deletes files
 * nothing else can reproduce. So the dialog does two jobs: it makes the scope an
 * explicit choice, and it shows what each scope would actually take **before**
 * anything is asked for — counts and sizes, from the server's own plan, not a
 * guess assembled in the browser.
 *
 * The least destructive scope is selected by default. Escalating is deliberate.
 */

const SCOPES: DiscoveryRemovalScope[] = ['catalog', 'monitoring', 'library'];

export function RemoveDiscoveryDialog({
  item,
  onClose,
  onRemoved,
}: {
  item: DiscoveredMediaItem;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const [scope, setScope] = useState<DiscoveryRemovalScope>('catalog');
  const [removeTorrent, setRemoveTorrent] = useState(false);

  const plan = useQuery({
    queryKey: ['discovery', 'removal-plan', item.id],
    queryFn: () => api.mediaDiscovery.removalPlan(item.id),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.mediaDiscovery.removeItem(item.id, {
        scope,
        // Only meaningful at library scope; sent as `keep` otherwise so the
        // server never has to infer intent from an absent field.
        torrentAction: (scope === 'library' && removeTorrent
          ? 'stop_and_delete'
          : 'keep') as DiscoveryTorrentAction,
      }),
    onSuccess: (result) => {
      toast.success(t('remove.done', { title: result.title }));
      // Anything deliberately left alone is surfaced rather than implied by a
      // success message that would otherwise read as "everything went".
      result.skipped.forEach((reason) => toast.info(reason));
      onRemoved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p = plan.data;
  const label = item.year ? `${item.title} (${item.year})` : item.title;

  return (
    <Dialog open onClose={onClose} title={t('remove.title', { title: label })}>
      <DialogHeader>
        <DialogTitle>{t('remove.title', { title: label })}</DialogTitle>
      </DialogHeader>

      {plan.isLoading && <CenteredSpinner />}
      {plan.isError && <ErrorState title={t('remove.planError')} />}

      {p && (
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
                name="discovery-removal-scope"
                className="mt-1"
                checked={scope === id}
                onChange={() => setScope(id)}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">{t(`remove.scope.${id}.label`)}</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {id === 'catalog' && (
                    <li>{t('remove.scope.catalog.detail', { evaluations: p.catalog.evaluations })}</li>
                  )}
                  {id === 'monitoring' && (
                    <>
                      <li>
                        {p.monitoring.rule
                          ? t('remove.scope.monitoring.rule', { name: p.monitoring.rule.name })
                          : t('remove.scope.monitoring.noRule')}
                      </li>
                      <li>
                        {p.monitoring.watchlistItem
                          ? t('remove.scope.monitoring.watchlist')
                          : t('remove.scope.monitoring.noWatchlist')}
                      </li>
                    </>
                  )}
                  {id === 'library' && (
                    <>
                      {p.library.unmatchedReason === 'no_external_ids' ? (
                        <li className="text-amber-300">{t('remove.scope.library.unidentified')}</li>
                      ) : (
                        <li>{t('remove.scope.library.items', { count: p.library.items.length })}</li>
                      )}
                      <li>{t('remove.scope.library.sidecars')}</li>
                    </>
                  )}
                </ul>
              </div>
            </label>
          ))}

          {/* Only offered where it can do anything. */}
          {scope === 'library' && p.library.items.length > 0 && (
            <label className="flex items-center gap-2 pl-3 text-xs">
              <Checkbox checked={removeTorrent} onCheckedChange={(v) => setRemoveTorrent(Boolean(v))} />
              {t('remove.alsoTorrent')}
            </label>
          )}

          {/*
            * Said plainly, because it is the difference between an inconvenience
            * and a loss. Files go to Trash via the same path-safe service the
            * File Manager uses — recoverable, not unlinked.
            */}
          {scope === 'library' && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('remove.trashNote')}
            </p>
          )}

          {p.monitoring.userModifiedRule && (
            <p className="text-xs text-muted-foreground">
              {t('remove.userRuleKept', { name: p.monitoring.userModifiedRule.name })}
            </p>
          )}

          <p className="text-xs text-muted-foreground">{t('remove.suppressNote')}</p>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
              {t('remove.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('remove.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
