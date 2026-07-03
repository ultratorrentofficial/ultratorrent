import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type BulkAction } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { DeleteTorrentDialog } from './DeleteTorrentDialog';
import { pluralize } from '@/lib/format';

export interface BulkToolbarProps {
  selected: string[];
  onClear: () => void;
}

export function BulkToolbar({ selected, onClear }: BulkToolbarProps) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (selected.length === 0) return null;

  const run = async (action: BulkAction, label: string) => {
    setPending(action);
    try {
      await api.torrents.bulk(selected, action);
      toast.success(`${label} applied`, pluralize(selected.length, 'torrent'));
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
    } catch (err) {
      toast.error(`Bulk ${label.toLowerCase()} failed`, err instanceof ApiError ? err.message : undefined);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 animate-fade-in">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{pluralize(selected.length, 'selected')}</span>

        <div className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'resume'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_RESUME)}
          onClick={() => run('resume', 'Resume')}
        >
          <Play className="h-4 w-4" /> Resume
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'pause'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_PAUSE)}
          onClick={() => run('pause', 'Pause')}
        >
          <Pause className="h-4 w-4" /> Pause
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'stop'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_STOP)}
          onClick={() => run('stop', 'Stop')}
        >
          <Square className="h-4 w-4" /> Stop
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'recheck'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_RECHECK)}
          onClick={() => run('recheck', 'Recheck')}
        >
          <RefreshCw className="h-4 w-4" /> Recheck
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
          disabled={!hasPermission(PERMISSIONS.TORRENTS_DELETE)}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      </div>

      <DeleteTorrentDialog
        open={confirmDelete}
        count={selected.length}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async (withData) => {
          try {
            await api.torrents.bulk(selected, withData ? 'removeData' : 'remove');
            toast.success('Torrents deleted', pluralize(selected.length, 'torrent'));
            await queryClient.invalidateQueries({ queryKey: ['torrents'] });
            setConfirmDelete(false);
            onClear();
          } catch (err) {
            toast.error('Bulk delete failed', err instanceof ApiError ? err.message : undefined);
          }
        }}
      />
    </>
  );
}
