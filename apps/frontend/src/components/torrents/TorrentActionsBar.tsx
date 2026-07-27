import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { EntityRef, NormalizedTorrent } from '@ultratorrent/shared';
import { ApiError, api, type TorrentAction } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { ActionMenu } from '@/actions/ActionMenu';
import { useContextActions } from '@/actions/useContextActions';
import type { ActionHandler } from '@/actions/ActionBar';
import { torrentCapabilities } from './torrentCapabilities';
import { DeleteTorrentDialog } from './DeleteTorrentDialog';

export interface TorrentActionsBarProps {
  torrent: NormalizedTorrent;
  onDeleted?: () => void;
}

/**
 * Actions for a single torrent, in the drawer.
 *
 * Shares its resolution with the bulk toolbar rather than reimplementing it.
 * The two were near-duplicate lists that had already drifted: this bar counted
 * a QUEUED torrent among the paused states while the bulk path treated it as
 * running, so the same torrent offered opposite actions depending on where you
 * clicked it. One declaration plus one `torrentCapabilities()` makes that class
 * of disagreement unrepresentable.
 *
 * It also showed Pause and Resume as an either/or derived from state alone, so
 * the wrong one was live whenever the state was one the set did not model.
 */
export function TorrentActionsBar({ torrent, onDeleted }: TorrentActionsBarProps) {
  const { t } = useTranslation('torrents');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selection = useMemo<EntityRef[]>(
    () => [{ type: 'torrent', id: torrent.hash, capabilities: torrentCapabilities(torrent) }],
    [torrent],
  );

  const { groups } = useContextActions({ selection });

  const handlers = useMemo<Record<string, ActionHandler>>(() => {
    const run = async (action: TorrentAction, label: string) => {
      setPending(true);
      try {
        await api.torrents.action(torrent.hash, action);
        toast.success(t('actions.requested', { action: label }));
        await queryClient.invalidateQueries({ queryKey: ['torrents'] });
      } catch (err) {
        toast.error(
          t('actions.failed', { action: label.toLowerCase() }),
          err instanceof ApiError ? err.message : undefined,
        );
      } finally {
        setPending(false);
      }
    };

    return {
      'torrents.resume': () => void run('resume', t('actions.resume')),
      'torrents.pause': () => void run('pause', t('actions.pause')),
      'torrents.stop': () => void run('stop', t('actions.stop')),
      'torrents.recheck': () => void run('recheck', t('actions.recheck')),
      // Both deletions route through the same confirmation; the dialog's own
      // checkbox decides whether data goes with it.
      'torrents.remove': () => setConfirmDelete(true),
      'torrents.removeData': () => setConfirmDelete(true),
    };
  }, [torrent.hash, t, toast, queryClient]);

  return (
    <>
      <ActionMenu
        groups={groups}
        selection={selection}
        handlers={handlers}
        variant="icons"
        busy={pending}
        className="w-full"
      />

      <DeleteTorrentDialog
        open={confirmDelete}
        count={1}
        name={torrent.name}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async (withData) => {
          try {
            await api.torrents.remove(torrent.hash, withData);
            toast.success(t('actions.deletedTitle'));
            await queryClient.invalidateQueries({ queryKey: ['torrents'] });
            setConfirmDelete(false);
            onDeleted?.();
          } catch (err) {
            toast.error(
              t('actions.deleteFailed'),
              err instanceof ApiError ? err.message : undefined,
            );
          }
        }}
      />
    </>
  );
}
