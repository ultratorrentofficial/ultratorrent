import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { TorrentState, type NormalizedTorrent } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type TorrentAction } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { DeleteTorrentDialog } from './DeleteTorrentDialog';

export interface TorrentActionsBarProps {
  torrent: NormalizedTorrent;
  onDeleted?: () => void;
}

const PAUSED_STATES = new Set<TorrentState>([
  TorrentState.PAUSED,
  TorrentState.STOPPED,
  TorrentState.QUEUED,
]);

export function TorrentActionsBar({ torrent, onDeleted }: TorrentActionsBarProps) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<TorrentAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isPaused = PAUSED_STATES.has(torrent.state);

  const run = async (action: TorrentAction, label: string) => {
    setPending(action);
    try {
      await api.torrents.action(torrent.hash, action);
      toast.success(`${label} requested`);
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
    } catch (err) {
      toast.error(`Failed to ${label.toLowerCase()}`, err instanceof ApiError ? err.message : undefined);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex w-full items-center gap-2">
        {isPaused ? (
          <Button
            variant="subtle"
            size="sm"
            loading={pending === 'resume'}
            disabled={!hasPermission(PERMISSIONS.TORRENTS_RESUME)}
            onClick={() => run('resume', 'Resume')}
          >
            <Play className="h-4 w-4" /> Resume
          </Button>
        ) : (
          <Button
            variant="subtle"
            size="sm"
            loading={pending === 'pause'}
            disabled={!hasPermission(PERMISSIONS.TORRENTS_PAUSE)}
            onClick={() => run('pause', 'Pause')}
          >
            <Pause className="h-4 w-4" /> Pause
          </Button>
        )}

        <Button
          variant="subtle"
          size="sm"
          loading={pending === 'stop'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_STOP)}
          onClick={() => run('stop', 'Stop')}
        >
          <Square className="h-4 w-4" /> Stop
        </Button>

        <Button
          variant="subtle"
          size="sm"
          loading={pending === 'recheck'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_RECHECK)}
          onClick={() => run('recheck', 'Recheck')}
        >
          <RefreshCw className="h-4 w-4" /> Recheck
        </Button>

        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          disabled={!hasPermission(PERMISSIONS.TORRENTS_DELETE)}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      </div>

      <DeleteTorrentDialog
        open={confirmDelete}
        count={1}
        name={torrent.name}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async (withData) => {
          try {
            await api.torrents.remove(torrent.hash, withData);
            toast.success('Torrent deleted');
            await queryClient.invalidateQueries({ queryKey: ['torrents'] });
            setConfirmDelete(false);
            onDeleted?.();
          } catch (err) {
            toast.error('Failed to delete', err instanceof ApiError ? err.message : undefined);
          }
        }}
      />
    </>
  );
}
