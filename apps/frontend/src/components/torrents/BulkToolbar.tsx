import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type BulkAction } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { DeleteTorrentDialog } from './DeleteTorrentDialog';

export interface BulkToolbarProps {
  selected: string[];
  onClear: () => void;
}

export function BulkToolbar({ selected, onClear }: BulkToolbarProps) {
  const { t } = useTranslation('torrents');
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
      toast.success(t('bulk.appliedTitle', { action: label }), t('count', { count: selected.length }));
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
    } catch (err) {
      toast.error(t('bulk.failedTitle', { action: label.toLowerCase() }), err instanceof ApiError ? err.message : undefined);
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
          aria-label={t('bulk.clearAria')}
        >
          <X className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{t('bulk.selected', { count: selected.length })}</span>

        <div className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'resume'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_RESUME)}
          onClick={() => run('resume', t('bulk.action.resume'))}
        >
          <Play className="h-4 w-4" /> {t('bulk.resume')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'pause'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_PAUSE)}
          onClick={() => run('pause', t('bulk.action.pause'))}
        >
          <Pause className="h-4 w-4" /> {t('bulk.pause')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'stop'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_STOP)}
          onClick={() => run('stop', t('bulk.action.stop'))}
        >
          <Square className="h-4 w-4" /> {t('bulk.stop')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={pending === 'recheck'}
          disabled={!hasPermission(PERMISSIONS.TORRENTS_RECHECK)}
          onClick={() => run('recheck', t('bulk.action.recheck'))}
        >
          <RefreshCw className="h-4 w-4" /> {t('bulk.recheck')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
          disabled={!hasPermission(PERMISSIONS.TORRENTS_DELETE)}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" /> {t('bulk.delete')}
        </Button>
      </div>

      <DeleteTorrentDialog
        open={confirmDelete}
        count={selected.length}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async (withData) => {
          try {
            await api.torrents.bulk(selected, withData ? 'removeData' : 'remove');
            toast.success(t('bulk.deletedTitle'), t('count', { count: selected.length }));
            await queryClient.invalidateQueries({ queryKey: ['torrents'] });
            setConfirmDelete(false);
            onClear();
          } catch (err) {
            toast.error(t('bulk.deleteFailed'), err instanceof ApiError ? err.message : undefined);
          }
        }}
      />
    </>
  );
}
