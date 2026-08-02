import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { EntityRef } from '@ultratorrent/shared';
import { ApiError, api, type BulkAction } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { ActionBar, type ActionHandler } from '@/actions/ActionBar';
import { useContextActions } from '@/actions/useContextActions';
import { DeleteTorrentDialog } from './DeleteTorrentDialog';

export interface BulkToolbarProps {
  /** The selected torrents, each carrying what its state currently allows. */
  selection: EntityRef[];
  onClear: () => void;
}

/**
 * Bulk actions over selected torrents, resolved from the CAMA catalogue.
 *
 * This bar and `TorrentActionsBar` were near-duplicate implementations of one
 * list. Both gated on permission — so unlike the Jobs Center this is a
 * consolidation, not a repair — but **neither considered torrent state**:
 * Resume was live on a downloading torrent and Pause on a stopped one, and
 * every such click was a request the engine would reject. State now travels
 * with each entity, so an action appears only where it can actually run.
 */
export function BulkToolbar({ selection, onClear }: BulkToolbarProps) {
  const { t } = useTranslation('torrents');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<'remove' | 'removeData' | null>(null);

  const { groups, isLoading, isError } = useContextActions({ selection });

  const run = async (action: BulkAction, hashes: string[], alsoLibrary = false) => {
    setPending(true);
    try {
      await api.torrents.bulk(hashes, action, alsoLibrary);
      toast.success(
        t('bulk.appliedTitle', { action: t(`bulk.action.${action}` as 'bulk.action.resume') }),
        t('count', { count: hashes.length }),
      );
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
      onClear();
    } catch (err) {
      toast.error(
        t('bulk.failedTitle', { action: action }),
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setPending(false);
    }
  };

  const handlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'torrents.resume': (sel) => run('resume', sel.map((e) => e.id)),
      'torrents.pause': (sel) => run('pause', sel.map((e) => e.id)),
      'torrents.stop': (sel) => run('stop', sel.map((e) => e.id)),
      'torrents.recheck': (sel) => run('recheck', sel.map((e) => e.id)),
      // Both deletions confirm first: they are the only actions here that
      // cannot be undone by clicking the opposite button.
      'torrents.remove': () => setConfirmDelete('remove'),
      'torrents.removeData': () => setConfirmDelete('removeData'),
    }),
    // `run` closes over nothing that changes per render beyond the toast and
    // query client, both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (selection.length === 0) return null;

  return (
    <>
      <ActionBar
        groups={groups}
        selection={selection}
        handlers={handlers}
        onClear={onClear}
        busy={pending}
        isLoading={isLoading}
        isError={isError}
        primaryGroups={['media']}
      />

      <DeleteTorrentDialog
        open={confirmDelete !== null}
        count={selection.length}
        hashes={selection.map((e) => e.id)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={(withData, alsoLibrary) => {
          const action: BulkAction =
            confirmDelete === 'removeData' || withData ? 'removeData' : 'remove';
          setConfirmDelete(null);
          void run(action, selection.map((e) => e.id), alsoLibrary);
        }}
      />
    </>
  );
}
