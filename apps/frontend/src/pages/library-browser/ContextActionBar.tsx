import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileCog, Lock, RefreshCw, ScanLine, Unlock, X } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';

type BulkOp = 'metadata' | 'lock' | 'unlock' | 'nfo';

/**
 * The toolbar, which changes with the selection.
 *
 * With nothing selected it offers library-wide work; with a selection it offers
 * operations over exactly those items. Both go to the server as **one** request
 * — the bulk routes take an id list and dispatch one job — rather than the
 * browser looping over the selection, which would give no single job to watch
 * and one audit row per item for a single action.
 *
 * Every action is gated on the permission its endpoint requires. Hiding a
 * button the server would refuse is not the security boundary — the guard is —
 * but offering one that always fails is its own kind of lie.
 */
export function ContextActionBar({
  libraryId, selectedIds, onClear,
}: {
  libraryId: string;
  selectedIds: readonly string[];
  onClear: () => void;
}) {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const canEdit = hasPermission(PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA);
  const canNfo = hasPermission(PERMISSIONS.MEDIA_MANAGER_GENERATE_NFO);
  const canScan = hasPermission(PERMISSIONS.MEDIA_MANAGER_SCAN);

  const bulk = useMutation({
    mutationFn: ({ op, ids }: { op: BulkOp; ids: string[] }) => api.media.bulkItems(op, ids),
    onSuccess: (result, { op }) => {
      // A job id means the work is still running — saying "done" would be false.
      toast.success(
        result.jobId
          ? t('browser.bulkQueued', { count: result.accepted })
          : t('browser.bulkApplied', { count: result.accepted }),
      );
      // Ids that resolved to nothing are surfaced, never swallowed: acting on
      // fewer items than were selected must not look like success.
      if (result.missing.length) {
        toast.error(t('browser.bulkMissing', { count: result.missing.length }));
      }
      if (op === 'lock' || op === 'unlock') {
        qc.invalidateQueries({ queryKey: ['library-browser'] });
      }
      onClear();
    },
    onError: (e: Error) => toast.error(e?.message || t('browser.bulkFailed')),
  });

  const scan = useMutation({
    mutationFn: () => api.media.scanLibrary(libraryId),
    onSuccess: () => toast.success(t('browser.scanStarted')),
    onError: (e: Error) => toast.error(e?.message || t('browser.bulkFailed')),
  });

  const count = selectedIds.length;
  const busy = bulk.isPending || scan.isPending;

  if (!count) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        <span className="text-xs text-muted-foreground">{t('browser.noSelection')}</span>
        <span className="flex-1" />
        {canScan && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => scan.mutate()}>
            <ScanLine className="mr-1.5 h-4 w-4" aria-hidden />
            {t('browser.scanLibrary')}
          </Button>
        )}
      </div>
    );
  }

  const run = (op: BulkOp) => bulk.mutate({ op, ids: [...selectedIds] });

  return (
    <div
      role="toolbar"
      aria-label={t('browser.actions')}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-white/20 bg-white/[0.06] px-3 py-2"
    >
      <span className="text-xs font-medium">{t('browser.selectedCount', { count })}</span>
      <span className="flex-1" />

      {canEdit && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('metadata')}>
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
          {t('browser.refreshMetadata')}
        </Button>
      )}
      {canNfo && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('nfo')}>
          <FileCog className="mr-1.5 h-4 w-4" aria-hidden />
          {t('browser.generateNfo')}
        </Button>
      )}
      {canEdit && (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('lock')}>
            <Lock className="mr-1.5 h-4 w-4" aria-hidden />
            {t('browser.lock')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('unlock')}>
            <Unlock className="mr-1.5 h-4 w-4" aria-hidden />
            {t('browser.unlock')}
          </Button>
        </>
      )}

      <Button size="sm" variant="ghost" onClick={onClear} aria-label={t('browser.clearSelection')}>
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
